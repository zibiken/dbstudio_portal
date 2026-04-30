-- M8 Task 8.4 — legal representative columns on customers.
--
-- The NDA template (templates/nda.html) interpolates the customer's
-- legal-representative identity into the signed body:
--   {{CLIENTE_REPRESENTANTE_NOMBRE}}, _DNI, _CARGO
-- These three values live with the customer because there is one
-- representative per customer in v1 (matches the Spanish company-rep
-- concept; multi-rep customers can be modelled later by promoting these
-- fields to a per-NDA override map).
--
-- All three columns are NULLABLE: existing customers already in the
-- system (M5/M7 onboardings) cannot have these set retroactively without
-- the operator typing them in via the admin customer-edit form. The NDA
-- generator (domain/ndas/service.js) refuses to render when any of the
-- three is NULL/empty so a half-populated customer can never produce a
-- legally-defective NDA.

ALTER TABLE customers
  ADD COLUMN representante_nombre TEXT,
  ADD COLUMN representante_dni    TEXT,
  ADD COLUMN representante_cargo  TEXT;
