import {
  encodeUuid,
  decodeUuid,
  isUuid,
  isEncodedUuid,
  encodeIfUuid,
  clearCodecCaches,
  isHexId,
  isEncodedHexId,
  encodeHexId,
  decodeHexId,
} from '../../../src/mqtt/codec';

describe('codec (topic ID)', () => {
  beforeEach(() => {
    clearCodecCaches();
  });

  const TEST_CASES = [
    {
      uuid: '550e8400-e29b-41d4-a716-446655440000',
      encoded: 'VQ6EAOKbQdSnFkRmVUQAAA',
    },
    {
      uuid: '00000000-0000-0000-0000-000000000000',
      encoded: 'AAAAAAAAAAAAAAAAAAAAAA',
    },
    {
      uuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      encoded: '_____________________w',
    },
    {
      uuid: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      encoded: 'a6e4EJ2tEdGAtADAT9QwyA',
    },
  ];

  describe('encodeUuid', () => {
    it.each(TEST_CASES)('encodes $uuid to $encoded', ({ uuid, encoded }) => {
      expect(encodeUuid(uuid)).toBe(encoded);
    });

    it('produces 22-char output for any valid UUID', () => {
      for (const { uuid } of TEST_CASES) {
        expect(encodeUuid(uuid)).toHaveLength(22);
      }
    });

    it('is case-insensitive for input', () => {
      const upper = '550E8400-E29B-41D4-A716-446655440000';
      const lower = '550e8400-e29b-41d4-a716-446655440000';
      expect(encodeUuid(upper)).toBe(encodeUuid(lower));
    });

    it('throws on invalid UUID format', () => {
      expect(() => encodeUuid('not-a-uuid')).toThrow('Invalid UUID');
      expect(() => encodeUuid('')).toThrow('Invalid UUID');
      expect(() => encodeUuid('550e8400e29b41d4a716446655440000')).toThrow('Invalid UUID');
    });
  });

  describe('decodeUuid', () => {
    it.each(TEST_CASES)('decodes $encoded back to $uuid', ({ uuid, encoded }) => {
      expect(decodeUuid(encoded)).toBe(uuid.toLowerCase());
    });

    it('throws on invalid encoded format', () => {
      expect(() => decodeUuid('short')).toThrow('Invalid encoded UUID');
      expect(() => decodeUuid('')).toThrow('Invalid encoded UUID');
      expect(() => decodeUuid('VQ6EAOKbQdSnFkRmVUQAAA==')).toThrow('Invalid encoded UUID');
    });
  });

  describe('round-trip consistency', () => {
    it.each(TEST_CASES)('encode then decode returns original UUID for $uuid', ({ uuid }) => {
      const encoded = encodeUuid(uuid);
      const decoded = decodeUuid(encoded);
      expect(decoded).toBe(uuid.toLowerCase());
    });

    it('works with randomly generated UUIDs', () => {
      // Generate a few pseudo-random UUIDs
      const uuids = [
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        '12345678-1234-1234-1234-123456789abc',
        'deadbeef-dead-beef-dead-beefdeadbeef',
      ];
      for (const uuid of uuids) {
        const encoded = encodeUuid(uuid);
        expect(encoded).toHaveLength(22);
        expect(decodeUuid(encoded)).toBe(uuid.toLowerCase());
      }
    });
  });

  describe('isUuid', () => {
    it('returns true for valid UUIDs', () => {
      expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });
    it('returns false for encoded UUIDs', () => {
      expect(isUuid('VQ6EAOKbQdSnFkRmVUQAAA')).toBe(false);
    });
    it('returns false for wildcards', () => {
      expect(isUuid('+')).toBe(false);
      expect(isUuid('#')).toBe(false);
    });
  });

  describe('isEncodedUuid', () => {
    it('returns true for encoded UUIDs', () => {
      expect(isEncodedUuid('VQ6EAOKbQdSnFkRmVUQAAA')).toBe(true);
    });
    it('returns false for raw UUIDs', () => {
      expect(isEncodedUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    });
  });

  describe('encodeIfUuid', () => {
    it('encodes valid UUIDs', () => {
      expect(encodeIfUuid('550e8400-e29b-41d4-a716-446655440000')).toBe('VQ6EAOKbQdSnFkRmVUQAAA');
    });
    it('passes through MQTT wildcards', () => {
      expect(encodeIfUuid('+')).toBe('+');
      expect(encodeIfUuid('#')).toBe('#');
      expect(encodeIfUuid('*')).toBe('*');
    });
    it('passes through already-encoded values', () => {
      expect(encodeIfUuid('VQ6EAOKbQdSnFkRmVUQAAA')).toBe('VQ6EAOKbQdSnFkRmVUQAAA');
    });
    it('passes through arbitrary strings', () => {
      expect(encodeIfUuid('endpoints')).toBe('endpoints');
    });
  });

  describe('caching', () => {
    it('returns same result from cache', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const first = encodeUuid(uuid);
      const second = encodeUuid(uuid);
      expect(first).toBe(second);
    });

    it('populates decode cache on encode', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const encoded = encodeUuid(uuid);
      // Second decode should hit cache populated by encode
      const decoded = decodeUuid(encoded);
      expect(decoded).toBe(uuid.toLowerCase());
    });
  });

  describe('hex tenant ID codec', () => {
    const HEX_TEST_CASES = [
      { hex: '000000000000', encoded: 'AAAAAAAA' },
      { hex: 'ffffffffffff', encoded: '________' },
      { hex: '73eddd385ce8', encoded: 'c-3dOFzo' }, // from real topic example
    ];

    describe('encodeHexId', () => {
      it.each(HEX_TEST_CASES)('encodes $hex to $encoded', ({ hex, encoded }) => {
        expect(encodeHexId(hex)).toBe(encoded);
      });

      it('produces 8-char output for any valid 12-char hex ID', () => {
        for (const { hex } of HEX_TEST_CASES) {
          expect(encodeHexId(hex)).toHaveLength(8);
        }
      });

      it('is case-insensitive for input', () => {
        expect(encodeHexId('73EDDD385CE8')).toBe(encodeHexId('73eddd385ce8'));
      });

      it('throws on invalid hex ID format', () => {
        expect(() => encodeHexId('not-hex-str')).toThrow('Invalid hex ID');
        expect(() => encodeHexId('73eddd385c')).toThrow('Invalid hex ID');   // 10 chars
        expect(() => encodeHexId('73eddd385ce800')).toThrow('Invalid hex ID'); // 14 chars
        expect(() => encodeHexId('')).toThrow('Invalid hex ID');
      });
    });

    describe('decodeHexId', () => {
      it.each(HEX_TEST_CASES)('decodes $encoded back to $hex', ({ hex, encoded }) => {
        expect(decodeHexId(encoded)).toBe(hex.toLowerCase());
      });

      it('throws on invalid encoded format', () => {
        expect(() => decodeHexId('short')).toThrow('Invalid encoded hex ID');
        expect(() => decodeHexId('AAAAAAAAA')).toThrow('Invalid encoded hex ID'); // 9 chars
        expect(() => decodeHexId('')).toThrow('Invalid encoded hex ID');
      });
    });

    describe('round-trip consistency', () => {
      it.each(HEX_TEST_CASES)('encode then decode returns original for $hex', ({ hex }) => {
        const encoded = encodeHexId(hex);
        expect(decodeHexId(encoded)).toBe(hex.toLowerCase());
      });
    });

    describe('isHexId', () => {
      it('returns true for valid 12-char hex IDs', () => {
        expect(isHexId('73eddd385ce8')).toBe(true);
        expect(isHexId('000000000000')).toBe(true);
        expect(isHexId('ABCDEF012345')).toBe(true);
      });

      it('returns false for UUIDs', () => {
        expect(isHexId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
      });

      it('returns false for wrong-length hex strings', () => {
        expect(isHexId('73eddd385c')).toBe(false);     // 10 chars
        expect(isHexId('73eddd385ce800')).toBe(false); // 14 chars
      });

      it('returns false for wildcards', () => {
        expect(isHexId('+')).toBe(false);
      });
    });

    describe('isEncodedHexId', () => {
      it('returns true for 8-char base64url encoded hex IDs', () => {
        expect(isEncodedHexId('AAAAAAAA')).toBe(true);
        expect(isEncodedHexId('c-3dOFzo')).toBe(true);
      });

      it('returns false for encoded UUIDs (22 chars)', () => {
        expect(isEncodedHexId('VQ6EAOKbQdSnFkRmVUQAAA')).toBe(false);
      });
    });

    describe('encodeIfUuid with hex IDs', () => {
      it('encodes 12-char hex IDs via encodeIfUuid', () => {
        expect(encodeIfUuid('73eddd385ce8')).toBe('c-3dOFzo');
        expect(encodeIfUuid('000000000000')).toBe('AAAAAAAA');
      });
    });
  });
});
