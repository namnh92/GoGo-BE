import { options as browseOptions } from './browse.js';
import browse from './browse.js';

/**
 * Two hours at a modest, steady load. Not a peak test — this is for the things
 * that only appear with time: a pool that never returns a connection, a cache
 * that only grows, an outbox that drains slightly slower than it fills.
 *
 * The thresholds are the same SLOs. A soak that quietly degrades and still
 * passes is a soak that measured nothing.
 */
export const options = {
  stages: [
    { duration: '5m', target: 20 },
    { duration: '110m', target: 20 },
    { duration: '5m', target: 0 },
  ],
  thresholds: browseOptions.thresholds,
};

export { setup } from './browse.js';
export default browse;
