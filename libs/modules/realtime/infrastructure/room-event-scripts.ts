import { createHash } from 'node:crypto';

/**
 * ADR-0027 D1/D2 — the two Redis scripts of the room event bus.
 *
 * KEYS[1] is the room's metadata hash `{generation, seq}` (never expires),
 * KEYS[2] its replay buffer ZSET (score = seq, 15-minute TTL). Both carry the
 * room id as a hash tag, so they live in one slot.
 *
 * Shared prologue: validate key types, then make sure metadata exists. Missing
 * metadata creates a fresh generation (the candidate UUID the caller passed)
 * and discards whatever buffer survived — identity is never reconstructed from
 * buffer scores, which is how a reset counter used to hand out a `seq` a client
 * had already seen (F-04).
 */
const PROLOGUE = `
local meta, buffer = KEYS[1], KEYS[2]
local metaType = redis.call('TYPE', meta)['ok']
if metaType ~= 'none' and metaType ~= 'hash' then
  return redis.error_reply('ROOM_EVENTS_BAD_KEY_TYPE meta')
end
local bufferType = redis.call('TYPE', buffer)['ok']
if bufferType ~= 'none' and bufferType ~= 'zset' then
  return redis.error_reply('ROOM_EVENTS_BAD_KEY_TYPE buffer')
end
local generation = redis.call('HGET', meta, 'generation')
if not generation then
  generation = ARGV[1]
  redis.call('DEL', buffer)
  redis.call('HSET', meta, 'generation', generation, 'seq', '0')
end
if not string.match(generation, '^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$') then
  return redis.error_reply('ROOM_EVENTS_BAD_METADATA generation')
end
local current = tonumber(redis.call('HGET', meta, 'seq'))
if not current or current < 0 or current ~= math.floor(current) then
  return redis.error_reply('ROOM_EVENTS_BAD_METADATA seq')
end
`;

/**
 * Publish: ARGV = candidate generation, event JSON, buffer size, buffer TTL
 * seconds, channel. One execution assigns the sequence, appends, trims,
 * refreshes the TTL and publishes the identical envelope, so concurrent
 * publishers on different instances are serialized and sequence order is
 * publication order (F-01). Returns `{generation, seq}`.
 */
export const PUBLISH_SCRIPT = `${PROLOGUE}
-- 2^53 - 2: the last sequence a JavaScript number still holds exactly.
if current >= 9007199254740990 then
  return redis.error_reply('ROOM_EVENTS_SEQ_OVERFLOW')
end
local seq = redis.call('HINCRBY', meta, 'seq', 1)
local seqText = string.format('%d', seq)
local message = '{"generation":"' .. generation .. '","seq":' .. seqText .. ',"event":' .. ARGV[2] .. '}'
redis.call('ZADD', buffer, seqText, message)
redis.call('ZREMRANGEBYRANK', buffer, 0, -(tonumber(ARGV[3]) + 1))
redis.call('EXPIRE', buffer, tonumber(ARGV[4]))
redis.call('PUBLISH', ARGV[5], message)
return {generation, seqText}
`;

/**
 * Snapshot: ARGV = candidate generation, requested generation ('' for none),
 * requested seq, limit. Reads generation, high-water mark and — only when the
 * requested generation is current — the retained events after the requested
 * seq up to the high-water mark, in one execution. Returns
 * `{generation, high, events}`.
 */
export const SNAPSHOT_SCRIPT = `${PROLOGUE}
local high = string.format('%d', current)
local events = {}
if ARGV[2] ~= '' and ARGV[2] == generation then
  local after = tonumber(ARGV[3])
  if after and after < current then
    events = redis.call('ZRANGEBYSCORE', buffer, '(' .. ARGV[3], high, 'LIMIT', 0, tonumber(ARGV[4]))
  end
end
return {generation, high, events}
`;

export const sha1 = (script: string) => createHash('sha1').update(script).digest('hex');
