#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const action = process.argv[2] || 'check';
const configPath = path.resolve(process.argv[3] || '.env.deploy');
const supported = new Set(['init', 'check', 'email', 'ticket', 'all']);
const inheritedEnv = { ...process.env };

if (!supported.has(action)) {
  console.error('Usage: node scripts/deployment/apply-config.mjs <init|check|email|ticket|all> [config-file]');
  process.exit(2);
}
if (!existsSync(configPath)) {
  console.error(`Missing ${configPath}. Copy .env.deploy.example to .env.deploy and fill it first.`);
  process.exit(1);
}

loadEnvFile(configPath);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in ${configPath}.`);
  if (/[\r\n]/u.test(value)) throw new Error(`${name} must be a single line.`);
  return value;
}

function httpsUrl(name) {
  const value = required(name).replace(/\/+$/u, '');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error(`${name} must use HTTPS.`);
  return value;
}

function integer(name, minimum, maximum) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function accessMode() {
  const value = required('RAPPTOR_PREDICTION_ACCESS_MODE').toLowerCase();
  if (!['email', 'ip'].includes(value)) throw new Error('RAPPTOR_PREDICTION_ACCESS_MODE must be email or ip.');
  return value;
}

function emailConfig() {
  const template = readFileSync(path.resolve('docs/supabase-otp-template.html'), 'utf8');
  if (!template.includes('{{ .Token }}')) throw new Error('The Supabase OTP template must contain {{ .Token }}.');
  return {
    projectRef: required('SUPABASE_PROJECT_REF'),
    managementToken: required('SUPABASE_MANAGEMENT_TOKEN'),
    siteUrl: httpsUrl('RAPPTOR_PUBLIC_SITE_URL'),
    supabaseUrl: httpsUrl('SUPABASE_URL'),
    anonKey: required('SUPABASE_ANON_KEY'),
    smtpPassword: required('SUPABASE_SMTP_PASSWORD'),
    resendApiKey: required('RESEND_API_KEY'),
    fromName: required('EMAIL_FROM_NAME'),
    fromAddress: required('EMAIL_FROM_ADDRESS'),
    subject: required('EMAIL_SUBJECT'),
    smtpHost: required('SUPABASE_SMTP_HOST'),
    smtpPort: String(integer('SUPABASE_SMTP_PORT', 1, 65535)),
    smtpUser: required('SUPABASE_SMTP_USER'),
    otpExpiry: integer('SUPABASE_OTP_EXPIRY_SECONDS', 60, 86400),
    otpLength: integer('SUPABASE_OTP_LENGTH', 6, 6),
    template,
  };
}

function ticketConfig() {
  return {
    workerBaseUrl: httpsUrl('RAPPTOR_WORKER_BASE_URL'),
    predictionServiceUrl: httpsUrl('RAPPTOR_PREDICTION_SERVICE_URL'),
    siteKey: required('NEXT_PUBLIC_RAPPTOR_TURNSTILE_SITE_KEY'),
    turnstileSecret: required('RAPPTOR_TURNSTILE_SECRET'),
    serviceSecret: required('RAPPTOR_PREDICTION_SERVICE_SECRET'),
    ipHashSecret: required('RAPPTOR_PREDICTION_IP_HASH_SECRET'),
    modelVersion: required('RAPPTOR_PREDICTION_MODEL_VERSION'),
    accessMode: accessMode(),
  };
}

function wranglerSecretBulk(secrets) {
  const wrangler = path.resolve('node_modules/wrangler/bin/wrangler.js');
  if (!existsSync(wrangler)) throw new Error('Run npm install before applying Cloudflare secrets.');
  const result = spawnSync(process.execPath, [wrangler, 'secret', 'bulk'], {
    cwd: process.cwd(),
    // Do not expose Supabase/Resend/Docker secrets to the Wrangler child process.
    env: inheritedEnv,
    input: JSON.stringify(secrets),
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.status !== 0) throw new Error('Cloudflare secret update failed.');
}

function upsertEnv(source, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'mu');
  return pattern.test(source) ? source.replace(pattern, line) : `${source.replace(/\s*$/u, '')}\n${line}\n`;
}

function initializeLocalSecrets() {
  let source = readFileSync(configPath, 'utf8');
  for (const name of ['RAPPTOR_PREDICTION_SERVICE_SECRET', 'RAPPTOR_PREDICTION_IP_HASH_SECRET']) {
    const pattern = new RegExp(`^${name}=(.*)$`, 'mu');
    const current = source.match(pattern)?.[1]?.trim();
    if (!current) source = upsertEnv(source, name, randomBytes(32).toString('base64url'));
  }
  writeFileSync(configPath, source, { encoding: 'utf8', mode: 0o600 });
  console.log('Local prediction service and IP-hash secrets are present; values were not printed.');
}

function writePublicTicketConfig(config) {
  const wranglerPath = path.resolve('wrangler.toml');
  let wrangler = readFileSync(wranglerPath, 'utf8');
  const variables = {
    RAPPTOR_PREDICTION_SERVICE_URL: config.predictionServiceUrl,
    RAPPTOR_PREDICTION_ACCESS_MODE: config.accessMode,
    RAPPTOR_DEPLOYMENT_ENV: 'production',
    RAPPTOR_PREDICTION_LOCAL_TEST: 'off',
    NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST: 'off',
    NEXT_PUBLIC_RAPPTOR_TURNSTILE_SITE_KEY: config.siteKey,
  };
  for (const [name, value] of Object.entries(variables)) {
    const pattern = new RegExp(`^${name}\\s*=.*$`, 'mu');
    if (!pattern.test(wrangler)) throw new Error(`${name} is missing from wrangler.toml.`);
    wrangler = wrangler.replace(pattern, `${name} = ${JSON.stringify(value)}`);
  }
  writeFileSync(wranglerPath, wrangler, 'utf8');

  const nextEnvPath = path.resolve('.env.production.local');
  let nextEnv = existsSync(nextEnvPath) ? readFileSync(nextEnvPath, 'utf8') : '';
  nextEnv = upsertEnv(nextEnv, 'NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST', 'off');
  nextEnv = upsertEnv(nextEnv, 'NEXT_PUBLIC_RAPPTOR_TURNSTILE_SITE_KEY', config.siteKey);
  nextEnv = upsertEnv(nextEnv, 'RAPPTOR_PREDICTION_ACCESS_MODE', config.accessMode);
  writeFileSync(nextEnvPath, nextEnv, { encoding: 'utf8', mode: 0o600 });
  console.log('Production Worker and browser public variables updated.');
}

function writePublicSiteConfig(siteUrl) {
  const wranglerPath = path.resolve('wrangler.toml');
  let wrangler = readFileSync(wranglerPath, 'utf8');
  const pattern = /^RAPPTOR_PUBLIC_SITE_URL\s*=.*$/mu;
  if (!pattern.test(wrangler)) throw new Error('RAPPTOR_PUBLIC_SITE_URL is missing from wrangler.toml.');
  wrangler = wrangler.replace(pattern, `RAPPTOR_PUBLIC_SITE_URL = ${JSON.stringify(siteUrl)}`);
  writeFileSync(wranglerPath, wrangler, 'utf8');
}

async function applyEmail() {
  const config = emailConfig();
  writePublicSiteConfig(config.siteUrl);
  const proxyUrl = inheritedEnv.HTTPS_PROXY || inheritedEnv.HTTP_PROXY;
  const dispatcher = proxyUrl ? new (await import('undici')).ProxyAgent(proxyUrl) : undefined;
  let response;
  try {
    response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(config.projectRef)}/config/auth`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${config.managementToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        site_url: config.siteUrl,
        disable_signup: false,
        external_email_enabled: true,
        mailer_autoconfirm: false,
        mailer_otp_exp: config.otpExpiry,
        mailer_otp_length: config.otpLength,
        smtp_admin_email: config.fromAddress,
        smtp_host: config.smtpHost,
        smtp_port: config.smtpPort,
        smtp_user: config.smtpUser,
        smtp_pass: config.smtpPassword,
        smtp_sender_name: config.fromName,
        mailer_subjects_confirmation: config.subject,
        mailer_subjects_magic_link: config.subject,
        mailer_templates_confirmation_content: config.template,
        mailer_templates_magic_link_content: config.template,
      }),
      dispatcher,
    });
    await response.arrayBuffer();
  } finally {
    await dispatcher?.close();
  }
  if (!response.ok) throw new Error(`Supabase Auth update failed with HTTP ${response.status}.`);
  wranglerSecretBulk({
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_ANON_KEY: config.anonKey,
    RESEND_API_KEY: config.resendApiKey,
    RESEND_FROM: `${config.fromName} <${config.fromAddress}>`,
  });
  console.log('Email configuration applied to Supabase and Cloudflare.');
}

function writeDockerEnv() {
  const config = ticketConfig();
  const names = [
    'RAPPTOR_MODEL_HOST_DIR',
    'RAPPTOR_GPU_INDEX',
    'RAPPTOR_API_PORT',
    'RAPPTOR_MAX_REQUEST_BYTES',
    'RAPPTOR_MAX_QUEUE_LENGTH',
    'RAPPTOR_MIN_SCAN_STRIDE',
    'RAPPTOR_MAX_SCAN_STRIDE',
    'RAPPTOR_DEFAULT_SCAN_STRIDE',
    'RAPPTOR_FILE_RETENTION_SECONDS',
  ];
  const lines = [
    `RAPPTOR_MODEL_VERSION=${config.modelVersion}`,
    ...names.map((name) => `${name}=${required(name)}`),
    'RAPPTOR_TICKET_VALIDATION_MODE=cloudflare',
    `RAPPTOR_TICKET_CONSUME_URL=${config.workerBaseUrl}/api/internal/prediction-tickets/consume`,
    `RAPPTOR_TICKET_SERVICE_SECRET=${config.serviceSecret}`,
    `RAPPTOR_JOB_CALLBACK_URL=${config.workerBaseUrl}/api/internal/prediction-jobs`,
    `RAPPTOR_JOB_CALLBACK_SECRET=${config.serviceSecret}`,
    '',
  ];
  const output = path.resolve('services/prediction/.env');
  writeFileSync(output, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  console.log(`Docker environment written to ${output}.`);
}

function applyTicket() {
  const config = ticketConfig();
  wranglerSecretBulk({
    RAPPTOR_PREDICTION_SERVICE_SECRET: config.serviceSecret,
    RAPPTOR_PREDICTION_IP_HASH_SECRET: config.ipHashSecret,
    RAPPTOR_TURNSTILE_SECRET: config.turnstileSecret,
  });
  writePublicTicketConfig(config);
  writeDockerEnv();
  console.log('Ticket configuration synchronized; deploy the Worker and recreate Docker API/worker with services/prediction/.env.');
}

try {
  if (action === 'init') {
    initializeLocalSecrets();
  } else if (action === 'check') {
    const config = ticketConfig();
    if (config.accessMode === 'email') emailConfig();
    console.log('Deployment configuration is complete.');
  } else if (action === 'email') {
    await applyEmail();
  } else if (action === 'ticket') {
    applyTicket();
  } else {
    if (accessMode() === 'email') await applyEmail();
    applyTicket();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration failed.');
  process.exit(1);
}
