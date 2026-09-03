import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles, seedProductTypes, seedUnitsOfMeasure } =
  await import('../test/db-helpers.js');

describe('/api/products, /api/product-types, /api/units-of-measure', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let categoryId: string;
  let productTypeId: string;
  let unitOfMeasureId: string;
  let flavorId: string;
  let adminAuthHeader: { authorization: string };
  let employeeAuthHeader: { authorization: string };

  beforeEach(async () => {
    await resetCoreTables();
    organizationId = await seedOrganization();
    const roleIds = await seedRoles();
    const productTypes = await seedProductTypes(organizationId);
    const unitsOfMeasure = await seedUnitsOfMeasure(organizationId);
    productTypeId = productTypes.HELADO;
    unitOfMeasureId = unitsOfMeasure.LATA;
    app = await buildServer();

    const category = await prisma.category.create({
      data: { organizationId, name: 'Sabores al agua' },
    });
    categoryId = category.id;
    const flavor = await prisma.flavor.create({ data: { organizationId, name: 'Limón' } });
    flavorId = flavor.id;

    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-prod@test.com',
        authSubject: 'sub-admin-prod',
      },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.SHOP_EMPLOYEE,
        displayName: 'Empleada',
        email: 'empleada-prod@test.com',
        authSubject: 'sub-empleada-prod',
      },
    });

    adminAuthHeader = { authorization: 'Bearer admin-token' };
    employeeAuthHeader = { authorization: 'Bearer empleada-token' };
    mockGetUser({
      data: { user: { id: 'sub-admin-prod', email: 'admin-prod@test.com' } },
      error: null,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function validPayload(overrides: Record<string, unknown> = {}) {
    return {
      code: 'P001',
      name: 'Limón',
      categoryId,
      productTypeId,
      unitOfMeasureId,
      unitsPerHandlingUnit: 1,
      flavorId,
      ...overrides,
    };
  }

  describe('creación', () => {
    it('un rol SHOP_EMPLOYEE no puede crear productos (403)', async () => {
      mockGetUser({
        data: { user: { id: 'sub-empleada-prod', email: 'empleada-prod@test.com' } },
        error: null,
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: employeeAuthHeader,
        payload: validPayload(),
      });
      expect(response.statusCode).toBe(403);
    });

    it('ADMIN crea un producto válido y queda auditado', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: adminAuthHeader,
        payload: validPayload(),
      });
      expect(response.statusCode).toBe(201);
      const created = response.json().data;
      expect(created.code).toBe('P001');
      expect(created.categoryName).toBe('Sabores al agua');
      expect(created.productTypeName).toBe('Helado');
      expect(created.unitOfMeasureName).toBe('Lata');
      expect(created.flavorName).toBe('Limón');

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'PRODUCT_CREATED', entityId: created.id },
      });
      expect(audit).not.toBeNull();
      expect(audit?.module).toBe('CATALOG');
    });

    it('rechaza un código de producto duplicado en la organización (409 CONFLICT)', async () => {
      await prisma.product.create({
        data: {
          organizationId,
          code: 'P001',
          name: 'Ya existe',
          categoryId,
          productTypeId,
          unitOfMeasureId,
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: adminAuthHeader,
        payload: validPayload(),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFLICT');
    });

    it('permite crear dos productos sin código (code: null) sin colisionar', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: adminAuthHeader,
        payload: validPayload({ code: null }),
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: adminAuthHeader,
        payload: validPayload({ code: null, name: 'Otro producto sin código' }),
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
    });

    it('rechaza una categoría de otra organización (aislamiento organizacional)', async () => {
      const otherOrg = await prisma.organization.create({ data: { name: 'Organización E' } });
      const otherCategory = await prisma.category.create({
        data: { organizationId: otherOrg.id, name: 'Categoría ajena' },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: adminAuthHeader,
        payload: validPayload({ categoryId: otherCategory.id }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rechaza un sabor de otra organización (aislamiento organizacional)', async () => {
      const otherOrg = await prisma.organization.create({ data: { name: 'Organización F' } });
      const otherFlavor = await prisma.flavor.create({
        data: { organizationId: otherOrg.id, name: 'Sabor ajeno' },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: adminAuthHeader,
        payload: validPayload({ flavorId: otherFlavor.id }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rechaza una categoría/tipo/unidad inexistente (referencia inexistente)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: adminAuthHeader,
        payload: validPayload({ categoryId: '00000000-0000-0000-0000-000000000000' }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rechaza unitsPerHandlingUnit inválido (0 o negativo) por validación de entrada', async () => {
      const zero = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: adminAuthHeader,
        payload: validPayload({ unitsPerHandlingUnit: 0 }),
      });
      expect(zero.statusCode).toBe(400);

      const negative = await app.inject({
        method: 'POST',
        url: '/api/products',
        headers: adminAuthHeader,
        payload: validPayload({ unitsPerHandlingUnit: -5 }),
      });
      expect(negative.statusCode).toBe(400);
    });

    it('el CHECK de la base de datos también protege units_per_handling_unit > 0', async () => {
      await expect(
        prisma.product.create({
          data: {
            organizationId,
            name: 'Bypass de Zod directo a Prisma',
            categoryId,
            productTypeId,
            unitOfMeasureId,
            unitsPerHandlingUnit: 0,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('actualización, activación/desactivación', () => {
    it('ADMIN actualiza un producto existente', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/products',
          headers: adminAuthHeader,
          payload: validPayload(),
        })
      ).json().data;

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/products/${created.id}`,
        headers: adminAuthHeader,
        payload: { unitsPerHandlingUnit: 12 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.unitsPerHandlingUnit).toBe(12);
    });

    it('ADMIN desactiva un producto y queda auditado con antes/después', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/products',
          headers: adminAuthHeader,
          payload: validPayload(),
        })
      ).json().data;

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/products/${created.id}`,
        headers: adminAuthHeader,
        payload: { active: false },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.active).toBe(false);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'PRODUCT_DEACTIVATED', entityId: created.id },
      });
      expect(audit).not.toBeNull();
      expect((audit?.beforeValue as { active: boolean }).active).toBe(true);
      expect((audit?.afterValue as { active: boolean }).active).toBe(false);
    });

    it('rechaza actualizar un producto que pertenece a otra organización (404)', async () => {
      const otherOrg = await prisma.organization.create({ data: { name: 'Organización G' } });
      const otherCategory = await prisma.category.create({
        data: { organizationId: otherOrg.id, name: 'Cat ajena' },
      });
      const otherTypes = await seedProductTypes(otherOrg.id);
      const otherUnits = await seedUnitsOfMeasure(otherOrg.id);
      const otherProduct = await prisma.product.create({
        data: {
          organizationId: otherOrg.id,
          name: 'Producto ajeno',
          categoryId: otherCategory.id,
          productTypeId: otherTypes.HELADO,
          unitOfMeasureId: otherUnits.LATA,
        },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/products/${otherProduct.id}`,
        headers: adminAuthHeader,
        payload: { active: false },
      });
      expect(response.statusCode).toBe(404);
    });

    it('un rol SHOP_EMPLOYEE no puede actualizar productos (403)', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/products',
          headers: adminAuthHeader,
          payload: validPayload(),
        })
      ).json().data;

      mockGetUser({
        data: { user: { id: 'sub-empleada-prod', email: 'empleada-prod@test.com' } },
        error: null,
      });
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/products/${created.id}`,
        headers: employeeAuthHeader,
        payload: { active: false },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('lectura', () => {
    it('lista y obtiene el detalle de un producto', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/products',
          headers: adminAuthHeader,
          payload: validPayload(),
        })
      ).json().data;

      const list = await app.inject({
        method: 'GET',
        url: '/api/products',
        headers: adminAuthHeader,
      });
      expect(list.json().data).toHaveLength(1);

      const detail = await app.inject({
        method: 'GET',
        url: `/api/products/${created.id}`,
        headers: adminAuthHeader,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().data.id).toBe(created.id);
    });

    it('devuelve 404 al pedir el detalle de un producto inexistente', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/products/00000000-0000-0000-0000-000000000000',
        headers: adminAuthHeader,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('/api/product-types y /api/units-of-measure (catálogos técnicos, sólo lectura)', () => {
    it('lista los tipos de producto sembrados', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/product-types',
        headers: adminAuthHeader,
      });
      expect(response.statusCode).toBe(200);
      expect(
        response
          .json()
          .data.map((pt: { code: string }) => pt.code)
          .sort(),
      ).toEqual(['HELADO', 'INSUMO']);
    });

    it('lista las unidades de manejo sembradas', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/units-of-measure',
        headers: adminAuthHeader,
      });
      expect(response.statusCode).toBe(200);
      expect(
        response
          .json()
          .data.map((uom: { code: string }) => uom.code)
          .sort(),
      ).toEqual(['CAJA', 'LATA', 'UNIDAD']);
    });

    it('un rol SHOP_EMPLOYEE no puede leer los catálogos técnicos (403)', async () => {
      mockGetUser({
        data: { user: { id: 'sub-empleada-prod', email: 'empleada-prod@test.com' } },
        error: null,
      });
      const response = await app.inject({
        method: 'GET',
        url: '/api/product-types',
        headers: employeeAuthHeader,
      });
      expect(response.statusCode).toBe(403);
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
