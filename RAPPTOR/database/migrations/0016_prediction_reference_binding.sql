-- Bind a prepared exact reference version to the ticket that authorized it.
ALTER TABLE prediction_tickets ADD COLUMN reference_accession TEXT;
