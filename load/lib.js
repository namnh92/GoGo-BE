import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';

/**
 * A registered user per VU. Load with a shared account would measure lock
 * contention on one row rather than the flow, and would trip the per-account
 * lockout within seconds.
 */
export function register() {
  const email = `load-${__VU}-${__ITER}-${Date.now()}@loadtest.invalid`;
  const res = http.post(
    `${BASE}/v1/auth/register`,
    JSON.stringify({ email, password: 'sufficiently-long-pw', displayName: `VU${__VU}` }),
    { headers: { 'content-type': 'application/json' }, tags: { name: 'register' } },
  );
  check(res, { registered: (r) => r.status === 201 });
  return res.json('accessToken');
}

export function authed(token) {
  return { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
}

export const base = BASE;
