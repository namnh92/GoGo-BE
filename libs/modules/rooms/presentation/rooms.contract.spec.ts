import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { AppError } from '../../shared/app-error';

/**
 * GoGo-BE#602 — a refusal the API performs but the contract does not declare is
 * a refusal no generated client has a branch for. `transitionRoom` is host-only
 * and `RoomPolicy.requireHost` runs before the state machine, so the operation
 * answers 403 long before it can answer 409; the contract listed only 200 and
 * 409, and GoGo-MobileApp had to handle `HOST_ONLY` off-contract (#251/PR #262).
 *
 * This reads the published document rather than a decorator because the
 * document is what consumers vendor: `openapi/gogo.v1.d.ts` is generated from
 * it, and a response missing here is missing from every client's types. The
 * runtime half (a member's transition answers 403 HOST_ONLY) is asserted in
 * `apps/api/test/rooms.int.spec.ts`.
 */
const SPEC = path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml');

type Responses = Record<string, { $ref?: string } | undefined>;
interface Operation {
  operationId?: string;
  responses?: Responses;
  security?: unknown[];
  requestBody?: {
    content?: Record<string, { schema?: SchemaObject }>;
  };
}
interface SchemaObject {
  type?: string | string[];
  required?: string[];
  enum?: string[];
  $ref?: string;
  properties?: Record<string, SchemaObject>;
}
interface Document {
  paths: Record<string, Record<string, Operation | unknown>>;
  components: {
    responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
    schemas: Record<string, SchemaObject>;
  };
}

const doc = parseYaml(readFileSync(SPEC, 'utf8')) as Document;

function operation(operationId: string): Operation {
  for (const item of Object.values(doc.paths)) {
    for (const op of Object.values(item)) {
      if (op && typeof op === 'object' && (op as Operation).operationId === operationId) {
        return op as Operation;
      }
    }
  }
  throw new Error(`operationId ${operationId} not found in ${SPEC}`);
}

describe('rooms contract', () => {
  it('transitionRoom declares the 403 its host-only policy returns (#602)', () => {
    // The status the policy actually throws, not a literal copied from the spec:
    // `requireHost`, `requireMember` and the guest-scope check all raise
    // `AppError.forbidden`.
    const status = String(
      AppError.forbidden('HOST_ONLY', 'Only the host can perform this action').httpStatus,
    );
    expect(status).toBe('403');

    const declared = operation('transitionRoom').responses?.[status];
    expect(declared, 'transitionRoom must declare 403').toBeDefined();

    // The shared component, so the body is typed as the error envelope that
    // carries `code: HOST_ONLY` — not an ad-hoc description with no schema.
    expect(declared?.$ref).toBe('#/components/responses/Forbidden');
    expect(doc.components.responses.Forbidden?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/ErrorEnvelope',
    });
  });

  it('RoomListItem carries the budget as facts, optional and additive (#637)', () => {
    const item = doc.components.schemas.RoomListItem!;
    // Additive: a row without a budget stays valid, so `budget` is not required.
    expect(item.required ?? []).not.toContain('budget');

    const budget = item.properties?.budget;
    expect(budget, 'RoomListItem.budget must exist').toBeDefined();
    expect(budget?.required).toEqual(['mode', 'amount', 'currency']);
    // The same unit vocabulary as RoomConstraints.budgetMode — total and
    // per_person stay distinct (core rule #4), never a composed sentence.
    expect(budget?.properties?.mode?.enum).toEqual(
      doc.components.schemas.RoomConstraints!.properties?.budgetMode?.enum,
    );
    expect(budget?.properties?.amount?.type).toBe('integer');
    expect(budget?.properties?.currency?.type).toBe('string');
  });

  it('previewRoomInvite accepts the credential in a body and returns only display facts (#758)', () => {
    const preview = operation('previewRoomInvite');
    expect(preview.security).toEqual([]);
    expect(preview.requestBody?.content?.['application/json']?.schema?.required).toEqual([
      'inviteCode',
    ]);
    expect(preview.responses?.['200']).toEqual({
      description: 'Minimal invitation facts; copy and money formatting are client-owned.',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/InvitePreview' } },
      },
    });

    const shape = doc.components.schemas.InvitePreview!;
    expect(shape.required).toEqual(['inviter', 'roomType', 'participantCount']);
    expect(shape.properties?.inviter?.required).toEqual([
      'displayName',
      'avatarUrl',
      'emailVerified',
    ]);
    expect(shape.properties?.budget?.required).toEqual(['mode', 'amount', 'currency']);
    expect(shape.properties?.budget?.properties?.amount?.type).toBe('integer');

    // Holding a code reveals no identifiers, credential echo, exact origin or
    // account contact. The screen cannot accidentally render data it never gets.
    for (const forbidden of [
      'inviteCode',
      'roomId',
      'memberId',
      'userId',
      'email',
      'originText',
      'originLat',
      'originLng',
      'members',
    ]) {
      expect(shape.properties).not.toHaveProperty(forbidden);
    }
  });
});
