/**
 * Password Generation Utility
 * Generates deployment-grade secure passwords for initial admin setup
 */

import crypto from 'crypto';

/**
 * Generate secure initial admin password
 * 
 * Used during customer deployment as the initial one-time password
 * for the default admin user. Customer MUST change on first login.
 * 
 * Requirements:
 * - Minimum 16 characters (deployment-grade strength)
 * - Mix of uppercase, lowercase, numbers, and special characters
 * - Avoid ambiguous characters (0/O, 1/l/I, etc.)
 * - Cryptographically random (uses crypto.randomInt)
 * 
 * @returns 16-character initial password with high entropy
 */
export function generateInitialAdminPassword(): string {
  // Character sets - avoiding ambiguous characters
  const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';      // No I/O
  const lowercase = 'abcdefghijkmnpqrstuvwxyz';      // No l/o
  const numbers = '23456789';                         // No 0/1
  const special = '!@#$%&*-+=';                       // Safe special chars

  const allChars = uppercase + lowercase + numbers + special;

  // Ensure at least one from each set
  let password = '';
  password += uppercase.charAt(crypto.randomInt(0, uppercase.length));
  password += lowercase.charAt(crypto.randomInt(0, lowercase.length));
  password += numbers.charAt(crypto.randomInt(0, numbers.length));
  password += special.charAt(crypto.randomInt(0, special.length));

  // Fill remaining (12 chars more = 16 total)
  for (let i = 0; i < 12; i++) {
    password += allChars.charAt(crypto.randomInt(0, allChars.length));
  }

  // Shuffle to avoid predictable patterns
  return password
    .split('')
    .sort(() => crypto.randomInt(-1, 2) - 0.5)
    .join('');
}
