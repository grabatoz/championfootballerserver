import sequelize from '../config/database';
import '../models';
import { User } from '../models';

async function run() {
  const userIds = [
    'b689a0af-c2a9-4217-bb24-b83e314daf76', // Alom User
    'aebcbe06-7475-44c6-940c-8319196cfd8d'  // Mahfuz User
  ];

  console.log('--- Inspecting Alom User & Mahfuz User Profile Details ---');
  for (const id of userIds) {
    const user = await User.findByPk(id);
    if (user) {
      console.log(`User: ${user.firstName} ${user.lastName}`);
      console.log(`  - Email: ${user.email}`);
      console.log(`  - Provider: ${(user as any).provider}`);
    } else {
      console.log(`User ID: ${id} not found.`);
    }
  }

  process.exit(0);
}

run().catch(console.error);
