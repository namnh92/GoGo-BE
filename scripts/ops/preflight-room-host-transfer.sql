-- Run before activation, with producers still disabled. Rows here stop rollout.
SELECT r.id, r.host_user_id, count(m.id) AS active_hosts
FROM rooms r LEFT JOIN room_members m ON m.room_id = r.id AND m.role = 'host' AND m.removed_at IS NULL
GROUP BY r.id HAVING count(m.id) <> 1 OR count(m.id) FILTER (
  WHERE m.user_id = r.host_user_id AND m.guest_session_id IS NULL) <> 1;
SELECT id FROM rooms WHERE created_by_user_id IS NULL;
SELECT id, room_id FROM room_members WHERE role = 'host' AND (user_id IS NULL OR guest_session_id IS NOT NULL);
