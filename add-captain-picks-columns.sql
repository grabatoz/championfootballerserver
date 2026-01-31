-- Add captain picks columns to Matches table
-- Defensive Impact and Mentality (Influence) player IDs for home and away teams

ALTER TABLE "Matches" ADD COLUMN IF NOT EXISTS "homeDefensiveImpactId" UUID;
ALTER TABLE "Matches" ADD COLUMN IF NOT EXISTS "homeMentalityId" UUID;
ALTER TABLE "Matches" ADD COLUMN IF NOT EXISTS "awayDefensiveImpactId" UUID;
ALTER TABLE "Matches" ADD COLUMN IF NOT EXISTS "awayMentalityId" UUID;

-- Add foreign key constraints (optional, if you want referential integrity)
ALTER TABLE "Matches" ADD CONSTRAINT "fk_home_defensive_impact" 
  FOREIGN KEY ("homeDefensiveImpactId") REFERENCES "Users"(id) ON DELETE SET NULL;
  
ALTER TABLE "Matches" ADD CONSTRAINT "fk_home_mentality" 
  FOREIGN KEY ("homeMentalityId") REFERENCES "Users"(id) ON DELETE SET NULL;
  
ALTER TABLE "Matches" ADD CONSTRAINT "fk_away_defensive_impact" 
  FOREIGN KEY ("awayDefensiveImpactId") REFERENCES "Users"(id) ON DELETE SET NULL;
  
ALTER TABLE "Matches" ADD CONSTRAINT "fk_away_mentality" 
  FOREIGN KEY ("awayMentalityId") REFERENCES "Users"(id) ON DELETE SET NULL;
