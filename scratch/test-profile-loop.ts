import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import models from '../src/models';
import sequelize from '../src/config/database';

const { User: UserModel, League: LeagueModel } = models;

async function main() {
  const id = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe';

  console.log('Warming up connections...');
  // Force a simple query to establish the pool
  await sequelize.query('SELECT 1');

  for (let i = 1; i <= 3; i++) {
    console.log(`\n--- Run ${i} ---`);
    const t = Date.now();
    const player = await UserModel.findByPk(id, {
      attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp', 'position', 'positionType', 'shirtNumber', 'email'],
      include: [{
        model: LeagueModel,
        as: 'leagues',
        attributes: ['id', 'name', 'image']
      }]
    });
    console.log(`Query 1 (User + leagues) took: ${Date.now() - t}ms`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
