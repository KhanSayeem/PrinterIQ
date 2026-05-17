import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error('Missing env var: SUPABASE_URL');
if (!supabaseServiceKey) throw new Error('Missing env var: SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Fixed UUIDs — safe to reference in tests
export const SEED_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const SEED_LEAD_IDS = {
  imported:   '00000000-0000-0000-0001-000000000001',
  enriched:   '00000000-0000-0000-0001-000000000002',
  qualified:  '00000000-0000-0000-0001-000000000003',
  contacted:  '00000000-0000-0000-0001-000000000004',
  archived:   '00000000-0000-0000-0001-000000000005',
};

async function seedTenant() {
  const { error } = await supabase
    .from('tenants')
    .upsert(
      {
        tenant_id: SEED_TENANT_ID,
        business_name: 'PrinterIQ',
        escalation_phone: '+61400457006',
        product_price_aud: 1500.00,
      },
      { onConflict: 'tenant_id' }
    );
  if (error) throw new Error(`seedTenant: ${error.message}`);
}

async function seedLeads() {
  const leads = [
    {
      id: SEED_LEAD_IDS.imported,
      tenant_id: SEED_TENANT_ID,
      first_name: 'Darren',
      last_name: 'Smith',
      email: 'darren@aquaoptions.com.au',
      email_status: 'verified',
      business_name: 'Aqua Options',
      city: 'Sydney',
      state: 'NSW',
      website_url: 'http://aquaoptions.com.au',
      vertical: 'tradies',
      status: 'imported',
      source_file: 'seed',
    },
    {
      id: SEED_LEAD_IDS.enriched,
      tenant_id: SEED_TENANT_ID,
      first_name: 'Barry',
      last_name: 'Jones',
      email: 'barry@bjplumbing.com.au',
      email_status: 'verified',
      business_name: 'BJ Plumbing',
      city: 'Brisbane',
      state: 'QLD',
      website_url: 'http://bjplumbing.com.au',
      vertical: 'tradies',
      status: 'enriched',
      source_file: 'seed',
    },
    {
      id: SEED_LEAD_IDS.qualified,
      tenant_id: SEED_TENANT_ID,
      first_name: 'Craig',
      last_name: 'Webb',
      email: 'craig@webbelectrical.com.au',
      email_status: 'verified',
      business_name: 'Webb Electrical',
      city: 'Perth',
      state: 'WA',
      website_url: 'http://webbelectrical.com.au',
      vertical: 'tradies',
      status: 'qualified',
      source_file: 'seed',
    },
    {
      id: SEED_LEAD_IDS.contacted,
      tenant_id: SEED_TENANT_ID,
      first_name: 'Eve',
      last_name: 'Nguyen',
      email: 'eve@nguyen-tiling.com.au',
      email_status: 'verified',
      business_name: 'Nguyen Tiling',
      city: 'Melbourne',
      state: 'VIC',
      website_url: 'http://nguyen-tiling.com.au',
      vertical: 'tradies',
      status: 'contacted',
      source_file: 'seed',
    },
    {
      id: SEED_LEAD_IDS.archived,
      tenant_id: SEED_TENANT_ID,
      first_name: 'Frank',
      last_name: 'Park',
      email: 'frank@parkroofing.com.au',
      email_status: 'verified',
      business_name: 'Park Roofing',
      city: 'Adelaide',
      state: 'SA',
      website_url: 'http://parkroofing.com.au',
      vertical: 'tradies',
      status: 'archived',
      source_file: 'seed',
    },
  ];

  const { error } = await supabase
    .from('leads')
    .upsert(leads, { onConflict: 'id' });
  if (error) throw new Error(`seedLeads: ${error.message}`);
}

async function verifySeed() {
  const { count: tenantCount, error: te } = await supabase
    .from('tenants')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', SEED_TENANT_ID);
  if (te) throw new Error(`verify tenants: ${te.message}`);
  if (tenantCount !== 1) throw new Error(`Expected 1 tenant, got ${tenantCount}`);

  const { count: leadCount, error: le } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', SEED_TENANT_ID)
    .eq('source_file', 'seed');
  if (le) throw new Error(`verify leads: ${le.message}`);
  if (leadCount !== 5) throw new Error(`Expected 5 seed leads, got ${leadCount}`);

  console.log(`✓ Seed verified: 1 tenant, 5 leads`);
}

async function main() {
  console.log('Seeding…');
  await seedTenant();
  await seedLeads();
  await verifySeed();
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
