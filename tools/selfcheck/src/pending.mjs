// A gate whose milestone has not landed yet. Exit 78 = PENDING (never PASS).
const [gate = "?", milestone = "?"] = process.argv.slice(2);
console.log(`PENDING ${gate} (milestone ${milestone})`);
process.exit(78);
