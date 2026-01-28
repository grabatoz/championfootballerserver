# Controllers Structure Documentation

## Overview
Controllers handle the business logic of the application. Routes are now cleaner and only responsible for routing requests to the appropriate controller functions.

## Structure

```
src/
├── controllers/
│   ├── index.ts                    # Exports all controllers
│   ├── authController.ts           # Authentication logic (login, register, logout)
│   ├── userController.ts           # User management (CRUD operations)
│   ├── leagueController.ts         # League management
│   ├── matchController.ts          # Match management
│   ├── seasonController.ts         # Season management
│   └── notificationController.ts   # Notification management
└── routes/
    ├── auth.ts                     # Auth routes (uses authController)
    ├── users.ts                    # User routes (uses userController)
    ├── leagues.ts                  # League routes (uses leagueController)
    ├── matches.ts                  # Match routes (uses matchController)
    ├── seasons.ts                  # Season routes (uses seasonController)
    └── notifications.ts            # Notification routes (uses notificationController)
```

## Benefits

### 1. **Separation of Concerns**
- Routes handle HTTP request/response
- Controllers handle business logic
- Models handle data structure

### 2. **Better Code Organization**
- Easy to find specific functionality
- Cleaner, more maintainable code
- Easier to test

### 3. **Reusability**
- Controller functions can be reused across different routes
- Common logic in one place

### 4. **Easier Testing**
- Controllers can be tested independently
- No need to mock HTTP context for unit tests

## How to Use Controllers

### Example 1: Season Routes (Already Implemented)

**Route File** (`src/routes/seasons.ts`):
```typescript
import Router from 'koa-router';
import { required } from '../modules/auth';
import * as seasonController from '../controllers/seasonController';

const router = new Router({ prefix: '/api/leagues/:leagueId/seasons' });

router.get('/', required, seasonController.getAllSeasons);
router.get('/active', required, seasonController.getActiveSeason);
router.post('/', required, seasonController.createNewSeason);

export default router;
```

**Controller File** (`src/controllers/seasonController.ts`):
```typescript
import { Context } from 'koa';
import Season from '../models/Season';

export const getAllSeasons = async (ctx: Context) => {
  const { leagueId } = ctx.params;
  
  const seasons = await Season.findAll({
    where: { leagueId },
    order: [['seasonNumber', 'DESC']]
  });

  ctx.body = {
    success: true,
    seasons
  };
};
```

### Example 2: How to Update Existing Routes

**Before** (Logic in Route):
```typescript
router.post('/login', async (ctx) => {
  const { email, password } = ctx.request.body;
  
  const user = await User.findOne({ where: { email } });
  if (!user) {
    ctx.throw(401, 'Invalid credentials');
    return;
  }
  
  // More logic...
  
  ctx.body = { success: true, user };
});
```

**After** (Using Controller):

**Route**:
```typescript
import * as authController from '../controllers/authController';

router.post('/login', authController.login);
```

**Controller**:
```typescript
export const login = async (ctx: Context) => {
  const { email, password } = ctx.request.body;
  
  const user = await User.findOne({ where: { email } });
  if (!user) {
    ctx.throw(401, 'Invalid credentials');
    return;
  }
  
  // More logic...
  
  ctx.body = { success: true, user };
};
```

## Available Controllers

### 1. **authController.ts**
- `register` - User registration
- `login` - User login
- `logout` - User logout
- `getCurrentUser` - Get authenticated user

### 2. **userController.ts**
- `getAllUsers` - Get all users
- `getUserById` - Get single user
- `createUser` - Create new user
- `updateUser` - Update user
- `deleteUser` - Delete user
- `getUserProfile` - Get current user profile

### 3. **leagueController.ts**
- `createLeague` - Create new league
- `getAllLeagues` - Get all leagues
- `getLeagueById` - Get single league
- `updateLeague` - Update league
- `deleteLeague` - Delete league
- `joinLeague` - Join league with invite code

### 4. **matchController.ts**
- `createMatch` - Create new match
- `getAllMatches` - Get all matches
- `getMatchById` - Get single match
- `updateMatch` - Update match
- `deleteMatch` - Delete match
- `getMatchesBySeason` - Get matches by season

### 5. **seasonController.ts**
- `getAllSeasons` - Get all seasons for a league
- `getActiveSeason` - Get active season
- `createNewSeason` - Create new season (ends current)
- `addPlayerToSeason` - Add player to active season
- `removePlayerFromSeason` - Remove player from season

### 6. **notificationController.ts**
- `getUserNotifications` - Get user's notifications
- `markNotificationAsRead` - Mark single notification as read
- `markAllAsRead` - Mark all notifications as read
- `deleteNotification` - Delete notification
- `getUnreadCount` - Get unread notification count

## Migration Guide

To migrate an existing route to use controllers:

1. **Create controller function** in appropriate controller file
2. **Move business logic** from route to controller
3. **Update route** to use controller function
4. **Test** the endpoint

### Step-by-Step Example:

**Step 1**: Find the route
```typescript
// In routes/leagues.ts
router.get('/:id', async (ctx) => {
  const league = await League.findByPk(ctx.params.id);
  ctx.body = { success: true, league };
});
```

**Step 2**: Create controller function
```typescript
// In controllers/leagueController.ts
export const getLeagueById = async (ctx: Context) => {
  const league = await League.findByPk(ctx.params.id);
  ctx.body = { success: true, league };
};
```

**Step 3**: Update route
```typescript
// In routes/leagues.ts
import * as leagueController from '../controllers/leagueController';

router.get('/:id', leagueController.getLeagueById);
```

## Best Practices

1. **Keep controllers focused** - One controller per resource
2. **Error handling** - Use `ctx.throw()` for errors
3. **Validation** - Validate input in controllers
4. **Type safety** - Use TypeScript interfaces
5. **Async/await** - Always use async/await for database operations

## Next Steps

The controllers have been created with basic structure. You need to:

1. Move existing logic from routes to controllers
2. Update routes to use controller functions
3. Add proper error handling
4. Add input validation
5. Write unit tests for controllers

## Example: Complete Controller

```typescript
import { Context } from 'koa';
import Season from '../models/Season';

export const createNewSeason = async (ctx: Context) => {
  try {
    // 1. Validate input
    const { leagueId } = ctx.params;
    const { copyPlayers = true } = ctx.request.body;

    // 2. Check permissions
    if (!ctx.state.user?.userId) {
      ctx.throw(401, 'Not authenticated');
      return;
    }

    // 3. Business logic
    const currentSeason = await Season.findOne({
      where: { leagueId, isActive: true }
    });

    if (!currentSeason) {
      ctx.throw(400, 'No active season found');
      return;
    }

    // End current season
    currentSeason.isActive = false;
    currentSeason.endDate = new Date();
    await currentSeason.save();

    // Create new season
    const newSeason = await Season.create({
      leagueId,
      seasonNumber: currentSeason.seasonNumber + 1,
      name: `Season ${currentSeason.seasonNumber + 1}`,
      isActive: true,
      startDate: new Date()
    });

    // 4. Return response
    ctx.body = {
      success: true,
      message: 'Season created successfully',
      season: newSeason
    };

  } catch (error) {
    console.error('Error creating season:', error);
    throw error;
  }
};
```

## Completed

✅ Season routes - **FULLY IMPLEMENTED**
⚠️ Other routes - **STRUCTURE CREATED** (need to move existing logic)

All basic controller structures have been created. The seasons controller is fully functional and demonstrates the pattern to follow for other controllers.
