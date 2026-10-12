ALTER TABLE previews ADD COLUMN requested_deployment_id UUID REFERENCES deployments(id);
ALTER TABLE previews ADD COLUMN runtime_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK (runtime_state IN ('unknown','running','missing','stopped'));
UPDATE previews SET requested_deployment_id=deployment_id;

-- Previous versions overwrote metadata with the latest attempt. Recover the last
-- successful serving metadata where a referenced container still exists.
UPDATE previews p SET deployment_id=d.id, commit_sha=d.commit_sha, image=d.image,
  container_port=d.container_port, runtime_state='running'
FROM deployments d WHERE p.container_id IS NOT NULL AND d.id=(
  SELECT successful.id FROM deployments successful
  WHERE successful.preview_id=p.id AND successful.status='healthy'
  ORDER BY successful.updated_at DESC, successful.created_at DESC LIMIT 1
);
UPDATE previews SET deployment_id=NULL,commit_sha=NULL,image=NULL WHERE container_id IS NULL;
