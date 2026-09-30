migrate((app) => {
  const collection = app.findCollectionByNameOrId("users");

  // Setting the rule to null restricts it to superusers only
  collection.createRule = null;

  app.save(collection);
}, (app) => {
  // Rollback: Revert to public registration
  const collection = app.findCollectionByNameOrId("users");

  collection.createRule = "";

  app.save(collection);
});