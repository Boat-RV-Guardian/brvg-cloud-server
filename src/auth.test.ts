import { describe, it, expect } from 'vitest';
import { safeEqual, keyAuthorized, classifyVehicleWebhookAuth } from './auth.js';

describe('safeEqual', () => {
  it('is true only for equal non-empty strings', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('secret', 'Secret')).toBe(false);
    expect(safeEqual('secret', 'secretx')).toBe(false);
  });
  it('is false for null/undefined operands', () => {
    expect(safeEqual(null, 'x')).toBe(false);
    expect(safeEqual('x', undefined)).toBe(false);
    expect(safeEqual(null, null)).toBe(false);
  });
});

describe('keyAuthorized (fail-closed)', () => {
  it('denies when no key is configured and not opted out', () => {
    expect(keyAuthorized(null, false, null)).toBe(false);
    expect(keyAuthorized('', false, 'anything')).toBe(false);
  });
  it('allows unauthenticated only when explicitly opted out', () => {
    expect(keyAuthorized(null, true, null)).toBe(true);
    expect(keyAuthorized(null, true, 'ignored')).toBe(true);
  });
  it('requires a matching key when one is configured (opt-out ignored)', () => {
    expect(keyAuthorized('secret', true, 'wrong')).toBe(false);
    expect(keyAuthorized('secret', false, 'secret')).toBe(true);
  });
});

describe('classifyVehicleWebhookAuth (SEC-4)', () => {
  it('is legacy when the vehicle has no secret', () => {
    expect(classifyVehicleWebhookAuth(undefined, null)).toBe('legacy');
    expect(classifyVehicleWebhookAuth('', 'anything')).toBe('legacy');
  });
  it('is ok only when the presented k matches the secret', () => {
    expect(classifyVehicleWebhookAuth('s3cr3t', 's3cr3t')).toBe('ok');
    expect(classifyVehicleWebhookAuth('s3cr3t', 'S3CR3T')).toBe('unauthenticated');
  });
  it('is unauthenticated when the secret is set but k is missing/wrong', () => {
    expect(classifyVehicleWebhookAuth('s3cr3t', null)).toBe('unauthenticated');
    expect(classifyVehicleWebhookAuth('s3cr3t', 'nope')).toBe('unauthenticated');
  });
});
