/**
 * Test script to check if notification API is working
 */

const fetch = require('node-fetch');

// Test user ID (from database - Tech user)
const TEST_USER_ID = 'ff7d9f68-b09b-4a74-95dc-3f2cc71d7593';

async function testNotificationAPI() {
  console.log('🧪 Testing Notification API Endpoint...\n');
  
  try {
    // Get auth token first
    console.log('🔐 Step 1: Getting auth token...');
    const loginRes = await fetch('http://localhost:5000/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'mstechsolutionor@gmail.com',
        password: 'Password123'
      })
    });

    if (!loginRes.ok) {
      console.error('❌ Login failed:', loginRes.status, await loginRes.text());
      return;
    }

    const loginData = await loginRes.json();
    const token = loginData.token;
    const userId = loginData.user.id;
    
    console.log('✅ Login successful');
    console.log('   Token:', token.substring(0, 30) + '...');
    console.log('   User ID:', userId);
    console.log('   User Name:', loginData.user.name);
    
    // Test notification API
    console.log('\n📡 Step 2: Fetching notifications...');
    const notifUrl = `http://localhost:5000/notifications?userId=${userId}`;
    console.log('   URL:', notifUrl);
    
    const notifRes = await fetch(notifUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    console.log('   Response Status:', notifRes.status);
    
    if (!notifRes.ok) {
      console.error('❌ Notification fetch failed');
      const errorText = await notifRes.text();
      console.error('   Error:', errorText);
      return;
    }

    const notifData = await notifRes.json();
    console.log('✅ Notification fetch successful\n');
    
    console.log('📊 Response Data:');
    console.log('   Success:', notifData.success);
    console.log('   Total notifications:', notifData.notifications?.length || 0);
    
    if (notifData.notifications && notifData.notifications.length > 0) {
      console.log('\n📬 MOTM_VOTE Notifications:');
      const motvmVotes = notifData.notifications.filter(n => n.type === 'MOTM_VOTE');
      console.log('   Found:', motvmVotes.length);
      
      motvmVotes.forEach((n, i) => {
        console.log(`\n   ${i + 1}. ${n.title}`);
        console.log(`      Body: ${n.body}`);
        console.log(`      Read: ${n.read}`);
        console.log(`      Created: ${new Date(n.created_at).toLocaleString()}`);
      });
      
      console.log('\n📬 All Notification Types:');
      const typeCount = {};
      notifData.notifications.forEach(n => {
        typeCount[n.type] = (typeCount[n.type] || 0) + 1;
      });
      Object.entries(typeCount).forEach(([type, count]) => {
        console.log(`   ${type}: ${count}`);
      });
    } else {
      console.log('   ⚠️ No notifications found');
    }
    
    console.log('\n✅ API Test Complete!');
    
  } catch (error) {
    console.error('\n❌ Error during API test:');
    console.error(error);
  }
}

testNotificationAPI();
