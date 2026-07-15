---
name: php-rules
description: PHP conventions and best practices
triggers:
  extensions: [.php]
  paths: ["src/Models/", "app/"]
  keywords: ["eloquent", "migration"]
  agents: ["coder-lite"]
always: false
priority: 7
---
When working with PHP code:
- Use type hints on all methods
- Follow PSR-12 coding standards
- Use dependency injection over facades
