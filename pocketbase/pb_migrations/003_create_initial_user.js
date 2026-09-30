migrate((app) => {
    let users = app.findCollectionByNameOrId("users")
    let record = new Record(users)
    //  $os.getenv(key)
    // or special local config file
    const email = $os.getenv("POCKETBASE_USER_EMAIL")
    const password = $os.getenv("POCKETBASE_USER_PASSWORD")
    if (!email) {
        app.logger().warn(`Env variable POCKETBASE_USER_EMAIL not set`)
    }
    if (!password) {
        app.logger().warn(`Env variable POCKETBASE_USER_PASSWORD not set`)
    }
    if (!email || !password){
        app.logger().warn("Not trying to create user through migration")
        return
    }

    // Check if this user is already present in database
    try {
        let oldRecord = app.findAuthRecordByEmail("users", email)
        // Present - return
        if (oldRecord) {
            return;
        }
    } catch(err) {
        app.logger().warn(`User is already present in database: ${email}`)
    }
    app.logger().info(`Creating user ${email}`)
    try {
        record.set("email", email ? email : "test@example.com")
        record.set("password", password ? password : "TestPassword")
        record.set("verified", true)
        app.save(record)
        app.logger().info(`Created user ${email}`)
    } catch(err) {
        app.logger().error("Failed creating user via migration script")
        app.logger().error(err)
    }
}, (app) => { // optional revert operation
    try {
        // Do not know during `migrate down` the user email passed in through ENV variable
        // app.logger().warn(`Removing user "test@example.com"`)
        // let record = app.findAuthRecordByEmail("users", "test@example.com")
        // app.delete(record)
    } catch {
        // silent errors (probably already deleted)
        // app.logger().warn(`User "test@example.com" doesn't exist`)
    }
})
