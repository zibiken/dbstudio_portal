-- Phase G (post-G4): per-project phases + checklists.
--
-- Phases are admin-managed milestones inside a project (e.g. "0", "0.5",
-- "1", "1.5", "Discovery"). Each phase has a status enum and an optional
-- list of checklist items; items can be admin-only or customer-visible.
--
-- Customer-side visibility (decision 4 of the design spec) is enforced
-- by:
--   (a) the route layer for the customer project detail page (only
--       phases where status != 'not_started' are loaded), AND
--   (b) the visible_to_customer flag baked into each audit_log row at
--       write time using phaseVisible(status) ≡ status IN
--       ('in_progress','blocked','done').
--
-- All audit rows for this feature carry metadata.customerId so the
-- existing lib/activity-feed.js filter (visible_to_customer = TRUE
-- AND metadata->>'customerId' = X) picks them up without modification.

CREATE TABLE project_phases (
  id            UUID        PRIMARY KEY,
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label         TEXT        NOT NULL,
  display_order INTEGER     NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'not_started'
                            CHECK (status IN ('not_started','in_progress','blocked','done')),
  started_at    TIMESTAMPTZ NULL,
  completed_at  TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_phases_label_unique
    UNIQUE (project_id, label),
  CONSTRAINT project_phases_order_unique
    UNIQUE (project_id, display_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_project_phases_project_order
  ON project_phases (project_id, display_order);

CREATE TABLE phase_checklist_items (
  id                   UUID        PRIMARY KEY,
  phase_id             UUID        NOT NULL REFERENCES project_phases(id) ON DELETE CASCADE,
  label                TEXT        NOT NULL,
  display_order        INTEGER     NOT NULL,
  visible_to_customer  BOOLEAN     NOT NULL DEFAULT TRUE,
  done_at              TIMESTAMPTZ NULL,
  done_by_admin_id     UUID        NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT phase_checklist_items_order_unique
    UNIQUE (phase_id, display_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_phase_checklist_items_phase_order
  ON phase_checklist_items (phase_id, display_order);
