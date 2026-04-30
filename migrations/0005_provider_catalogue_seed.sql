-- 0005_provider_catalogue_seed.sql
--
-- Seeds provider_catalogue with curated suggestions used by the admin
-- credential-request builder for autocomplete and field pre-fills. The
-- catalogue is NOT a closed set: credentials.provider and
-- credential_requests.provider remain free-text, so admins can type any
-- provider name (e.g. "Combell", "Website admin", "M365"). Catalogue rows
-- only short-circuit common cases.
--
-- default_fields shape: JSON array of {name, label, type, required}
-- where type ∈ {'text','secret','url','note'}. Customers fulfilling a
-- specific request answer the fields the admin set on that request — the
-- catalogue's default_fields is purely a UX nicety to pre-fill the form
-- when an admin types a known provider name.
--
-- ON CONFLICT (slug) DO NOTHING: belt-and-suspenders. The migration runner
-- already gates re-applies via the _migrations ledger, so a normal `runner`
-- pass won't touch this twice. The ON CONFLICT covers the manual-psql case
-- (someone copy-pasting this file straight into the DB during incident
-- response) and protects operator edits to existing rows from being
-- clobbered. Updates to existing rows remain intentionally manual.

INSERT INTO provider_catalogue (slug, display_name, default_fields, active) VALUES
  ('aws', 'Amazon Web Services',
   '[
     {"name":"access_key_id","label":"Access Key ID","type":"text","required":true},
     {"name":"secret_access_key","label":"Secret Access Key","type":"secret","required":true},
     {"name":"default_region","label":"Default Region","type":"text","required":false}
   ]'::jsonb, TRUE),

  ('azure', 'Microsoft Azure',
   '[
     {"name":"tenant_id","label":"Tenant ID","type":"text","required":true},
     {"name":"client_id","label":"Client ID","type":"text","required":true},
     {"name":"client_secret","label":"Client Secret","type":"secret","required":true},
     {"name":"subscription_id","label":"Subscription ID","type":"text","required":false}
   ]'::jsonb, TRUE),

  ('bitbucket', 'Bitbucket',
   '[
     {"name":"workspace","label":"Workspace","type":"text","required":true},
     {"name":"username","label":"Username","type":"text","required":true},
     {"name":"app_password","label":"App Password","type":"secret","required":true}
   ]'::jsonb, TRUE),

  ('cloudflare', 'Cloudflare',
   '[
     {"name":"account_id","label":"Account ID","type":"text","required":true},
     {"name":"api_token","label":"API Token","type":"secret","required":true},
     {"name":"zone_id","label":"Zone ID","type":"text","required":false}
   ]'::jsonb, TRUE),

  ('cpanel', 'cPanel',
   '[
     {"name":"panel_url","label":"Panel URL","type":"url","required":true},
     {"name":"username","label":"Username","type":"text","required":true},
     {"name":"password","label":"Password","type":"secret","required":true}
   ]'::jsonb, TRUE),

  ('digitalocean', 'DigitalOcean',
   '[
     {"name":"api_token","label":"API Token","type":"secret","required":true},
     {"name":"team_id","label":"Team ID","type":"text","required":false}
   ]'::jsonb, TRUE),

  ('dns-provider', 'DNS provider',
   '[
     {"name":"provider_name","label":"Provider Name","type":"text","required":true},
     {"name":"login_url","label":"Login URL","type":"url","required":true},
     {"name":"username","label":"Username","type":"text","required":true},
     {"name":"password","label":"Password","type":"secret","required":true},
     {"name":"api_token","label":"API Token","type":"secret","required":false}
   ]'::jsonb, TRUE),

  ('domain-registrar', 'Domain registrar',
   '[
     {"name":"registrar_name","label":"Registrar Name","type":"text","required":true},
     {"name":"login_url","label":"Login URL","type":"url","required":true},
     {"name":"username","label":"Username","type":"text","required":true},
     {"name":"password","label":"Password","type":"secret","required":true},
     {"name":"two_fa_recovery","label":"2FA Recovery Codes","type":"note","required":false}
   ]'::jsonb, TRUE),

  ('email-service', 'Email service',
   '[
     {"name":"provider_name","label":"Provider Name","type":"text","required":true},
     {"name":"login_url","label":"Login URL","type":"url","required":true},
     {"name":"username","label":"Username","type":"text","required":true},
     {"name":"password","label":"Password","type":"secret","required":true},
     {"name":"api_token","label":"API Token","type":"secret","required":false}
   ]'::jsonb, TRUE),

  ('gcp', 'Google Cloud Platform',
   '[
     {"name":"project_id","label":"Project ID","type":"text","required":true},
     {"name":"service_account_email","label":"Service Account Email","type":"text","required":true},
     {"name":"service_account_key_json","label":"Service Account Key (JSON)","type":"secret","required":true}
   ]'::jsonb, TRUE),

  ('github', 'GitHub',
   '[
     {"name":"username","label":"Username","type":"text","required":true},
     {"name":"personal_access_token","label":"Personal Access Token","type":"secret","required":true},
     {"name":"organization","label":"Organization","type":"text","required":false}
   ]'::jsonb, TRUE),

  ('gitlab', 'GitLab',
   '[
     {"name":"instance_url","label":"Instance URL","type":"url","required":true},
     {"name":"username","label":"Username","type":"text","required":true},
     {"name":"personal_access_token","label":"Personal Access Token","type":"secret","required":true}
   ]'::jsonb, TRUE),

  ('hetzner', 'Hetzner',
   '[
     {"name":"account_email","label":"Account Email","type":"text","required":true},
     {"name":"password","label":"Password","type":"secret","required":true},
     {"name":"api_token","label":"API Token","type":"secret","required":false}
   ]'::jsonb, TRUE),

  ('kinsta', 'Kinsta',
   '[
     {"name":"account_email","label":"Account Email","type":"text","required":true},
     {"name":"password","label":"Password","type":"secret","required":true},
     {"name":"site_id","label":"Site ID","type":"text","required":false}
   ]'::jsonb, TRUE),

  ('mailersend', 'MailerSend',
   '[
     {"name":"account_email","label":"Account Email","type":"text","required":true},
     {"name":"api_token","label":"API Token","type":"secret","required":true},
     {"name":"sending_domain","label":"Sending Domain","type":"text","required":false}
   ]'::jsonb, TRUE),

  ('s3-bucket', 'S3-compatible bucket',
   '[
     {"name":"bucket_name","label":"Bucket Name","type":"text","required":true},
     {"name":"access_key_id","label":"Access Key ID","type":"text","required":true},
     {"name":"secret_access_key","label":"Secret Access Key","type":"secret","required":true},
     {"name":"region","label":"Region","type":"text","required":false},
     {"name":"endpoint_url","label":"Endpoint URL","type":"url","required":false}
   ]'::jsonb, TRUE),

  ('stripe', 'Stripe',
   '[
     {"name":"account_email","label":"Account Email","type":"text","required":true},
     {"name":"publishable_key","label":"Publishable Key","type":"text","required":false},
     {"name":"secret_key","label":"Secret Key","type":"secret","required":true},
     {"name":"webhook_secret","label":"Webhook Signing Secret","type":"secret","required":false}
   ]'::jsonb, TRUE),

  ('vps-root', 'VPS root access',
   '[
     {"name":"host","label":"Host (IP or domain)","type":"text","required":true},
     {"name":"ssh_user","label":"SSH User","type":"text","required":true},
     {"name":"ssh_port","label":"SSH Port","type":"text","required":false},
     {"name":"ssh_password","label":"SSH Password","type":"secret","required":false},
     {"name":"ssh_private_key","label":"SSH Private Key","type":"secret","required":false},
     {"name":"notes","label":"Access Notes","type":"note","required":false}
   ]'::jsonb, TRUE),

  ('wordpress-admin', 'WordPress admin',
   '[
     {"name":"site_url","label":"Site URL","type":"url","required":true},
     {"name":"username","label":"Username","type":"text","required":true},
     {"name":"password","label":"Password","type":"secret","required":true},
     {"name":"two_fa_method","label":"2FA Method","type":"text","required":false}
   ]'::jsonb, TRUE),

  ('wp-engine', 'WP Engine',
   '[
     {"name":"account_email","label":"Account Email","type":"text","required":true},
     {"name":"password","label":"Password","type":"secret","required":true},
     {"name":"site_id","label":"Site ID","type":"text","required":false}
   ]'::jsonb, TRUE)
ON CONFLICT (slug) DO NOTHING;
