import http from 'k6/http';
import { check, sleep } from 'k6';
import { authed, base, register } from './lib.js';

/**
 * The read path: search and place detail, which is what most traffic is.
 * Thresholds are the SLOs from runbooks §3 — the run fails and names the one
 * it broke, rather than producing a chart someone has to interpret.
 */
export const options = {
  stages: [
    { duration: '2m', target: 50 },
    { duration: '6m', target: 50 },
    { duration: '2m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.001'], // availability 99.9%
    'http_req_duration{name:search}': ['p(95)<700'],
    'http_req_duration{name:detail}': ['p(95)<500'],
  },
};

export function setup() {
  return { token: register() };
}

export default function (data) {
  const options = authed(data.token);
  const search = http.get(`${base}/v1/places/search?q=cafe&lat=10.7769&lng=106.7009&radiusM=3000`, {
    ...options,
    tags: { name: 'search' },
  });
  check(search, { 'search ok': (r) => r.status === 200 });

  const results = search.json('results') || [];
  if (results.length > 0) {
    const detail = http.get(`${base}/v1/places/${results[0].id}`, {
      ...options,
      tags: { name: 'detail' },
    });
    check(detail, { 'detail ok': (r) => r.status === 200 });
  }
  sleep(1);
}
