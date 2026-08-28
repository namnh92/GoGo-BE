import http from 'k6/http';
import { check } from 'k6';
import { base } from './lib.js';

/** Is it alive and are its dependencies answering. Run before anything else. */
export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    // Readiness, not liveness: a process that is up while its database is not
    // passes the wrong check.
    'http_req_failed{name:ready}': ['rate==0'],
    'http_req_duration{name:ready}': ['p(95)<500'],
  },
};

export default function () {
  const res = http.get(`${base}/v1/health/ready`, { tags: { name: 'ready' } });
  check(res, { ready: (r) => r.status === 200 });
}
