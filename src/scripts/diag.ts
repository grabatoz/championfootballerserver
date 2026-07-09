import sequelize from '../config/database';
import '../models';
import { User } from '../models';

async function run() {
  console.log('--- Listing 5 Most Recently Created Users ---');
  const users = await User.findAll({
    order: [['createdAt', 'DESC']],
    limit: 5
  });

  users.forEach(u => {
    console.log(`User: ${u.firstName} ${u.lastName} | Email: ${u.email} | Created At: ${u.createdAt} | IsVerified: ${u.isVerified}`);
  });

  process.exit(0);
}

run().catch(console.error);
