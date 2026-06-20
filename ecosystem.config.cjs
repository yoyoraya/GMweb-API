module.exports = {
  apps: [
    {
      name: "gmweb-api",
      script: "src/server.js",
      env: {
        NODE_ENV: "production"
      },
      max_restarts: 10,
      restart_delay: 3000
    }
  ]
};
