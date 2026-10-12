ALTER TABLE previews ADD COLUMN container_port INTEGER CHECK (container_port BETWEEN 1 AND 65535);
UPDATE previews p SET container_port=d.container_port FROM deployments d
WHERE p.deployment_id=d.id AND p.container_id IS NOT NULL;
