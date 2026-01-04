-- Reset device dictionaries to rebuild with new field names
-- Run this after renaming registerName → metric

DELETE FROM device_dictionary_entries;
DELETE FROM device_dictionary_metadata;

-- Devices will automatically rebuild dictionaries on next publish
