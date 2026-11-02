# Read-only Staging acceptance trigger

This isolated integration branch intentionally changes no runtime code. Its only purpose is to run the existing `post-deploy-staging-smoke` job against the currently active Staging Worker. This is not candidate validation and does not deploy, merge, or change traffic.
