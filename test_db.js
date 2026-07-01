
const { Sequelize } = require('sequelize');
const sequelize = new Sequelize('postgresql://salman1209:Malik,g12@38.49.208.233:5432/postgres', { logging: false });
sequelize.query('SELECT COUNT(*)::int AS count FROM 'LeagueMember' lm2 JOIN users u_count ON lm2.'userId' = u_count.id WHERE lm2.'leagueId' = (SELECT id FROM 'Leagues' WHERE name = \'SEASON 7 FNF\' LIMIT 1) AND (u_count.provider IS NULL OR u_count.provider != \'guest\') AND COALESCE(u_count.email, \'\') NOT ILIKE \'%guest%\' AND (u_count.'firstName' IS NULL OR u_count.'firstName' NOT ILIKE \'%guest%\')').then(res => { console.log(res[0]); process.exit(0); }).catch(err => { console.error(err); process.exit(1); });

