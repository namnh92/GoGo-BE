-- Read-only; no personal identifiers or mutation. Keep all legacy seed data.
begin read only;
select room_id, count(distinct place_id) as distinct_seeds
from room_seed_places group by room_id having count(distinct place_id) > 10;

select s.room_id, s.place_id, 'missing_or_cross_room_creator' as anomaly
from room_seed_places s left join room_members m on m.id = s.created_by_member_id
where m.id is null or m.room_id <> s.room_id;

select r.id as room_id, 'missing_current_constraint' as anomaly
from rooms r left join room_constraints c on c.room_id = r.id and c.version = r.constraint_version
where c.id is null;

select r.id as room_id, 'host_authority_inconsistent' as anomaly
from rooms r left join room_members m on m.room_id=r.id and m.removed_at is null and m.role='host'
group by r.id, r.host_user_id
having count(m.id) <> 1 or count(m.id) filter (where m.user_id = r.host_user_id) <> 1;
rollback;
