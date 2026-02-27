-- Migration: Update MQTT broker to use TLS/SSL (MQTTS)
-- Purpose: Enable secure MQTT communication with TLS on port 8883
-- Created: 2025-11-12
-- Note: Skipped for e2e environment - use environment variables instead

-- Skip this migration in e2e environment (port 5883 indicates e2e/test mode)
-- E2E uses mqtt://localhost:5883 without TLS, configured via environment variables
DO $$
DECLARE
  current_port INTEGER;
BEGIN
  -- Get current port from mqtt.brokers.1
  SELECT (value->>'port')::INTEGER INTO current_port
  FROM system_config
  WHERE key = 'mqtt.brokers.1';
  
  -- Only apply TLS migration if current port is NOT 5883 (not in e2e mode)
  IF current_port IS NULL OR current_port != 5883 THEN
    -- Update existing mqtt.brokers.1 configuration to use MQTTS
    UPDATE system_config
    SET 
      value = value 
        || jsonb_build_object('protocol', 'mqtts')
        || jsonb_build_object('port', 8883)
        || jsonb_build_object('useTls', false)
        || jsonb_build_object('updatedAt', CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP
    WHERE key = 'mqtt.brokers.1';
    
    RAISE NOTICE 'Updated MQTT broker to use TLS (mqtts:8883)';
  ELSE
    RAISE NOTICE 'Skipping TLS migration - e2e environment detected (port 5883)';
  END IF;
END $$;

-- Add CA certificate as separate config entry for easier management
INSERT INTO system_config (key, value, updated_at)
VALUES (
  'mqtt.ca_certificate',
  to_jsonb('-----BEGIN CERTIFICATE-----
MIIFDTCCAvWgAwIBAgIUbLOu8GQmsAj6oXpldwNBG1+/u9UwDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLSW90aXN0aWMgQ0EwHhcNMjUxMTEyMjMzNjEzWhcNMjYx
MTEyMjMzNjEzWjAWMRQwEgYDVQQDDAtJb3Rpc3RpYyBDQTCCAiIwDQYJKoZIhvcN
AQEBBQADggIPADCCAgoCggIBALytVGBdn9uBz3KJ1ZHMDTbwwChLKChGrV/r0uZr
AgYfvkILjOxwJ4OGbogxvbgZHStU72BqnJiWYI50OZQdsVIT3wBXIr8SehUFD98E
JuMKnX22hYAwXTkey6x5lMqGMJBQTgqlFRaqaP1o46J59WFQFuJufrOFDX/oOup2
mKbN6T85nB+gkF/S9H9884sB7sbT1Lh38fGoS+FJn2VidcnpMPI9ouMvN5q1QDpB
QffBAHLGx6AEiF3PD5x9SMB17jkR6Gi9cfooHOINJGNZO+yuqRURX+MVgbGE/Uas
Lq5vswSaOTRX8/WobxRwe7cCeda1rEXyLBdzAC7/FcTFTvlZbVPqVBSl/BkEVNdI
uHMXOGK6yYXWlUcY03g6u8Gnq2ieuq4ExfACFw4+md5oTyADLlkyDwNsPG7Pr5mo
LN80wG2haUk7Q8+4SqX/nStqQE8Kns8OXIsXWyUD9fZrYaHs/d3GZDD1ATs1uvFG
SHVKMn9TAKYctD4ps+I1HyC4tXApYK1cab3HO4UbuX1Eugdm91o3X6pWaShZ9+tG
70eUcBiKsSw2/ZCUGn5mA7dZW6LmnnrKXp6PNiM/x+Rs9ZkKzoMMpLG/qXfQ3NXk
ZBRyCaud0mrovN+Ao42hgePAb2QBsnqQx+/E2Teoae3w+H6zk1mT/0qslWcgE3B7
uSD7AgMBAAGjUzBRMB0GA1UdDgQWBBRaAsgVVNk4gh4ahPCCGKqYp0mnHzAfBgNV
HSMEGDAWgBRaAsgVVNk4gh4ahPCCGKqYp0mnHzAPBgNVHRMBAf8EBTADAQH/MA0G
CSqGSIb3DQEBCwUAA4ICAQBNaeArX0uoPDOEGpBLdImS4Lf7xSPDBXV0Hhcr/Wet
asLznAPJ3ySc/6mtzxNXR/1i7B1RUI40XRojZfokiE1+EFsIeAaNBzAa+CCdzHuT
SA3HFHjlJL3xyp4pJYodpUtHgH8aza7Z8s6ipAULnK9kedgODxUU9n7QAmpHqkKh
sHQDLACF5T8ma0fr6TCdppZ2Tdn7HlIo8CSxcRp53O10I8/peuMEzgsbBH3PmF70
h6JXiyGj6hFPWi5K5FiGa3MGHXocViKi4fNhi17wAJbWQWUpC1UeG/hVpx43ZEUw
/kfuZrzZsm1jheyPi+uMkMf2cyOQuJ+bzhXyFg7dLwZrP6M4K9qiomh4QcTtBinm
LGYLwJxM36cs85fCs7YYuGC08OKrqvsS8eLqSEHCE0ewyxrfKrNphBnwcjCrp5jN
pJmQOZbrrborah9mz7NgExpRQ6CQJJo6bg25VCehm+whfm/JJcV5j4lKaQy5p5TV
bEKL68aVLmo2mf5qq61/mOEBp/gbR/kKYbd0AKO+jtaEu8d1U/FKN5zmaQiFbN6Z
1HH0NG0wm6ufMyyVSnmhbgk6GDoVAOEk+gD7AhGgX6Tkn/ocrSS1jBwdzxlCwv0h
AON0KT4qpHeIPDhYnP0eAMOvozhv7p4qxjNLxH67shW4r0vX++U7KqCpsDiDX87G
nA==
-----END CERTIFICATE-----'::text),
  CURRENT_TIMESTAMP
)
ON CONFLICT (key) DO UPDATE 
SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

-- Now update the broker config to reference the CA cert
UPDATE system_config
SET 
  value = jsonb_set(value, '{caCert}', (SELECT value FROM system_config WHERE key = 'mqtt.ca_certificate')),
  updated_at = CURRENT_TIMESTAMP
WHERE key = 'mqtt.brokers.1';

-- Verification query (run manually to check):
-- SELECT key, 
--        value->>'protocol' as protocol, 
--        value->>'host' as host, 
--        value->>'port' as port, 
--        value->>'useTls' as use_tls,
--        length(value->>'caCert') as ca_cert_length
-- FROM system_config 
-- WHERE key = 'mqtt.brokers.1';
