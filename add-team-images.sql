-- Add team image columns to matches table
ALTER TABLE matches 
ADD COLUMN homeTeamImage VARCHAR(255) NULL,
ADD COLUMN awayTeamImage VARCHAR(255) NULL;
 
-- Update existing matches to have NULL values for team images
UPDATE matches 
SET homeTeamImage = NULL, awayTeamImage = NULL 
WHERE homeTeamImage IS NULL OR awayTeamImage IS NULL;
