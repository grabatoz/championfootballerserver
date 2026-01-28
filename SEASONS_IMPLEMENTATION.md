# Seasons Feature Implementation

## Overview
This update restructures the application to support seasons within leagues. Instead of matches belonging directly to leagues, matches now belong to seasons, which in turn belong to leagues. This allows for better organization and the ability to track players across different seasons.

## Key Changes

### 1. Database Schema
- **New `Seasons` table**: Stores season information
  - `id`: UUID primary key
  - `leagueId`: Foreign key to Leagues table
  - `seasonNumber`: Integer (1, 2, 3, etc.)
  - `name`: String (e.g., "Season 1", "Season 2")
  - `isActive`: Boolean (only one active season per league)
  - `startDate`: Date when season started
  - `endDate`: Date when season ended (null for active seasons)

- **New `SeasonPlayers` join table**: Tracks which players are in which seasons
  - `seasonId`: Foreign key to Seasons
  - `userId`: Foreign key to Users

- **Updated `Matches` table**: Added `seasonId` column
  - Matches now belong to a season (and still reference league for backwards compatibility)

### 2. Models
- **Created `Season.ts`**: New Sequelize model for seasons
- **Updated `Match.ts`**: Added seasonId field and Season association
- **Updated `League.ts`**: Added hasMany relationship with Seasons
- **Updated `models/index.ts`**: Imported and exported Season model

### 3. Business Logic Changes

#### League Creation
When a league is created:
1. League is created as before
2. **Season 1 is automatically created** for the league
3. The league creator is added to Season 1
4. Season 1 is marked as active

#### Joining a League
When a player joins a league:
1. Player is added to the league (as before)
2. **Player is automatically added to the currently active season**

#### Creating Matches
When a match is created:
1. System finds the active season for the league
2. Match is assigned to that season via `seasonId`
3. If no active season exists, match creation fails with error

### 4. New API Endpoints

#### Get All Seasons for a League
```
GET /api/leagues/:leagueId/seasons
```
Returns all seasons for a league, ordered by season number (newest first).

#### Get Active Season
```
GET /api/leagues/:leagueId/seasons/active
```
Returns the currently active season with its players.

#### Create New Season
```
POST /api/leagues/:leagueId/seasons
Body: { copyPlayers: true/false }
```
- Ends the current active season (sets `isActive` to false, sets `endDate`)
- Creates a new season with incremented season number
- Optionally copies players from previous season to new season
- Only league admins can create new seasons

#### Add Player to Current Season
```
POST /api/leagues/:leagueId/seasons/players/:userId
```
Adds a player to the currently active season. Only league admins can do this.

#### Remove Player from Current Season
```
DELETE /api/leagues/:leagueId/seasons/players/:userId
```
Removes a player from the currently active season. Only league admins can do this.

## Migration

A migration file has been created: `migrations/20250124-add-seasons.js`

### What the migration does:
1. Creates the `Seasons` table
2. Creates the `SeasonPlayers` join table
3. Adds `seasonId` column to `Matches` table
4. **For all existing leagues**:
   - Creates Season 1
   - Assigns all existing matches to Season 1
   - Adds all current league members to Season 1

### Running the migration:
```bash
cd championfootballerserver
npm run migrate
# or
npx sequelize-cli db:migrate
```

## Usage Examples

### Admin Creates a New Season
When Season 1 is complete and you want to start Season 2:
```javascript
POST /api/leagues/abc123/seasons
{
  "copyPlayers": true  // Copies all players from Season 1 to Season 2
}
```

### Check Current Season
```javascript
GET /api/leagues/abc123/seasons/active

Response:
{
  "success": true,
  "season": {
    "id": "xyz789",
    "seasonNumber": 2,
    "name": "Season 2",
    "isActive": true,
    "startDate": "2026-01-24T...",
    "players": [...]
  }
}
```

### New Player Joins
When a new player joins the league while Season 2 is active:
1. Player automatically joins Season 2 (not Season 1)
2. Player can participate in matches created in Season 2

## Benefits

1. **Better Organization**: Matches are grouped by seasons
2. **Fresh Starts**: Each season can have different players
3. **Historical Data**: Can track performance across different seasons
4. **Flexibility**: Can add/remove players per season without affecting league membership
5. **Competitive Seasons**: Can create tournaments or competitions per season

## Important Notes

- Only ONE season can be active per league at a time
- All new matches are created in the active season
- When creating a new season, the previous season is automatically ended
- Existing data is preserved - old matches still belong to their original seasons
- Season numbers auto-increment (Season 1, Season 2, Season 3, etc.)

## Files Modified

### New Files:
- `src/models/Season.ts`
- `src/routes/seasons.ts`
- `migrations/20250124-add-seasons.js`

### Modified Files:
- `src/models/Match.ts`
- `src/models/League.ts`
- `src/models/index.ts`
- `src/routes/leagues.ts`
- `src/routes/index.ts`

## Next Steps

1. Run the database migration
2. Test league creation (should auto-create Season 1)
3. Test joining a league (should add to active season)
4. Test creating matches (should assign to active season)
5. Test creating a new season when ready to start Season 2
