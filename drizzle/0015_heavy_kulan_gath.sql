CREATE INDEX "lead_conflict_checks_firm_lead_idx" ON "lead_conflict_checks" USING btree ("firm_id","lead_id","checked_at");--> statement-breakpoint
CREATE INDEX "lead_parties_firm_hash_idx" ON "lead_parties" USING btree ("firm_id","name_hash");--> statement-breakpoint
CREATE INDEX "leads_firm_queue_idx" ON "leads" USING btree ("firm_id","status","follow_up_at");