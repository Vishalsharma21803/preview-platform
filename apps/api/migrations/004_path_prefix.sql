ALTER TABLE previews RENAME COLUMN hostname TO path_prefix;
UPDATE previews SET path_prefix = '/pr-' || pull_request_number;
