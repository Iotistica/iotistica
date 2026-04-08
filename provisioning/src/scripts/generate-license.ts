import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { LicenseGenerator } from '../services/license-generator';
import type { Customer } from '../db/customer-model';
import type { Subscription } from '../db/subscription-model';

dotenv.config();

type Plan = 'starter' | 'professional' | 'enterprise';

interface CliArgs {
  customerId: string;
  tenantId?: string;
  email: string;
  companyName: string;
  plan: Plan;
  trialDays: number;
  out?: string;
}

function usage(): void {
  console.log(
    [
      'Usage:',
      '  ts-node src/scripts/generate-license.ts --customer-id <id> [options]',
      '',
      'Options:',
      '  --customer-id <id>     Required. Source customer identifier used to derive clientId',
      '  --tenant-id <id>       Optional. Override the derived tenantId (e.g. use existing tenant: 73eddd385ce8)',
      '  --email <email>        Optional. Default: test@example.com',
      '  --company <name>       Optional. Default: Test Corp',
      '  --plan <plan>          Optional. starter|professional|enterprise (default: starter)',
      '  --trial-days <n>       Optional. Trial period in days (default: 14)',
      '  --out <path>           Optional. Write token to file path',
      '  --help                 Show this help',
    ].join('\n')
  );
}

function parseArgs(argv: string[]): CliArgs {
  const getArg = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const customerId = getArg('--customer-id');
  if (!customerId) {
    usage();
    throw new Error('Missing required argument: --customer-id');
  }

  const planArg = (getArg('--plan') || 'starter').toLowerCase();
  if (!['starter', 'professional', 'enterprise'].includes(planArg)) {
    throw new Error(`Invalid --plan value: ${planArg}`);
  }

  const trialDaysRaw = getArg('--trial-days') || '14';
  const trialDays = Number.parseInt(trialDaysRaw, 10);
  if (!Number.isFinite(trialDays) || trialDays < 1) {
    throw new Error(`Invalid --trial-days value: ${trialDaysRaw}`);
  }

  return {
    customerId,
    tenantId: getArg('--tenant-id'),
    email: getArg('--email') || 'test@example.com',
    companyName: getArg('--company') || 'Test Corp',
    plan: planArg as Plan,
    trialDays,
    out: getArg('--out'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  LicenseGenerator.init();

  const now = new Date();
  const trialEnd = new Date(now.getTime() + args.trialDays * 24 * 60 * 60 * 1000);

  const customer: Customer = {
    id: 0,
    customer_id: args.customerId,
    email: args.email,
    company_name: args.companyName,
    created_at: now,
    updated_at: now,
  };

  const subscription: Subscription = {
    id: 0,
    customer_id: args.customerId,
    plan: args.plan,
    status: 'trialing',
    trial_ends_at: trialEnd,
    current_period_start: now,
    current_period_ends_at: trialEnd,
    created_at: now,
    updated_at: now,
  };

  const token = await LicenseGenerator.generateLicense(customer, subscription, args.tenantId);
  const decoded = await LicenseGenerator.verifyLicense(token);

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, token, 'utf8');
    console.log(`License written to: ${outPath}`);
  }

  console.log('--- TOKEN ---');
  console.log(token);
  console.log('--- SUMMARY ---');
  console.log(
    JSON.stringify(
      {
        tenantId: decoded.tenantId,
        clientId: decoded.clientId,
        plan: decoded.plan,
        trial: decoded.trial,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('License generation failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
