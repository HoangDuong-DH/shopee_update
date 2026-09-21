-- Source identity survives token/capability revisions and new operation IDs.
CREATE UNIQUE INDEX prepared_wire_source_create_once ON prepared_wire_operations(owner_key,source_key)
 WHERE input->'plan'->>'operation'='create' AND state<>'blocked';
