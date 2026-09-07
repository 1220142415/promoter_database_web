-- Encrypted, temporary capability links for opening completed tasks from email.
ALTER TABLE prediction_job_notifications ADD COLUMN access_token_ciphertext TEXT;
ALTER TABLE prediction_job_notifications ADD COLUMN reference_name TEXT;
