import http from 'k6/http';
import { check, sleep } from 'k6';
import { authed, base, register } from './lib.js';

/**
 * The write path: room, preferences, suggestion run, plan. The suggestion run
 * is the expensive one and the reason this is separate from browse — mixing
 * them would hide a slow pipeline behind fast searches.
 */
export const options = {
  stages: [
    { duration: '2m', target: 20 },
    { duration: '6m', target: 20 },
    { duration: '2m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.001'],
    'http_req_duration{name:create_room}': ['p(95)<500'],
    // The suggestion budget, same number the engine counts itself against.
    'http_req_duration{name:suggestions}': ['p(95)<3000'],
  },
};

export default function () {
  const token = register();
  const options = authed(token);

  const room = http.post(
    `${base}/v1/rooms`,
    JSON.stringify({
      type: 'group',
      decisionMode: 'vote',
      participantCount: 3,
      constraint: {
        budgetMode: 'per_person',
        budgetAmount: 300000,
        currency: 'VND',
        originLat: 10.7769,
        originLng: 106.7009,
        radiusM: 5000,
      },
    }),
    { ...options, tags: { name: 'create_room' } },
  );
  check(room, { 'room created': (r) => r.status === 201 });
  if (room.status !== 201) return;

  const roomId = room.json('id');
  http.put(
    `${base}/v1/rooms/${roomId}/preferences/me`,
    JSON.stringify({ selections: { mood: ['chill'] }, expectedVersion: 0 }),
    { ...options, tags: { name: 'preferences' } },
  );
  http.post(`${base}/v1/rooms/${roomId}/preferences/complete`, null, {
    ...options,
    tags: { name: 'complete' },
  });

  const suggestions = http.post(`${base}/v1/rooms/${roomId}/suggestions`, null, {
    ...options,
    tags: { name: 'suggestions' },
  });
  check(suggestions, { 'suggestions ok': (r) => r.status === 201 || r.status === 200 });
  sleep(2);
}
