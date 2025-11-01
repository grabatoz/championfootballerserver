import { hash, compare } from 'bcrypt';
import User from './src/models/User';
import sequelize from './src/config/database';

async function checkUserPasswords() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection established.');

    // Get all users
    const users = await User.findAll({
      attributes: ['id', 'email', 'password', 'positionType']
    });

    
    console.log(`\n📊 Found ${users.length} users in database:`);
    
    for (const user of users) {
      console.log(`\n👤 User: ${user.email}`);
      console.log(`   ID: ${user.id}`);
      console.log(`   Password hash: ${user.password ? '✅ Present' : '❌ Missing'}`);
      console.log(`   Password length: ${user.password?.length || 0}`);
      console.log(`   PositionType: ${user.positionType || '❌ Not set'}`);
      
      // Test password comparison with a known password
      if (user.password) {
        const testPassword = 'password123';
        try {
          const isMatch = await compare(testPassword, user.password);
          console.log(`   Test password 'password123' match: ${isMatch ? '✅ Yes' : '❌ No'}`);
        } catch (error) {
          if (error instanceof Error) {
            console.log(`   ❌ Password comparison error:`, error.message);
          } else {
            console.log(`   ❌ Password comparison error:`, error);
          }
        }
      }
    }

    // Check if positionType column exists
    const [results] = (await sequelize.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'positionType'
    `) as unknown) as [Array<{ column_name: string; data_type: string; is_nullable: string }>];
    
    console.log(`\n🗄️ Database schema check:`);
    if (results.length > 0) {
      console.log('✅ positionType column exists in database');
      console.log(`   Type: ${results[0].data_type}`);
      console.log(`   Nullable: ${results[0].is_nullable}`);
    } else {
      console.log('❌ positionType column does not exist in database');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await sequelize.close();
  }
}

checkUserPasswords(); 