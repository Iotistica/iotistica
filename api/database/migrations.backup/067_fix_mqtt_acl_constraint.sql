-- Fix mqtt_acls table to allow SUBSCRIBE access (4)
-- Current constraint only allows 1, 2, 3 (READ, WRITE, READWRITE)
-- Need to allow 4 (SUBSCRIBE) and combinations like 7 (READ+WRITE+SUBSCRIBE)

-- Drop the old constraint
ALTER TABLE mqtt_acls DROP CONSTRAINT valid_access;

-- Add new constraint that allows bitwise combinations:
-- 1 = READ
-- 2 = WRITE
-- 3 = READWRITE (1+2)
-- 4 = SUBSCRIBE
-- 5 = READ+SUBSCRIBE (1+4)
-- 6 = WRITE+SUBSCRIBE (2+4)
-- 7 = ALL (1+2+4)
ALTER TABLE mqtt_acls ADD CONSTRAINT valid_access CHECK (access >= 1 AND access <= 7);

-- Update comment
COMMENT ON COLUMN mqtt_acls.access IS '1=read, 2=write, 3=readwrite, 4=subscribe, 5=read+subscribe, 6=write+subscribe, 7=all';
