I want to create a cursor Agent that does automatic PR reviews everytime a PR condition meets. It should be triggered automatically when a PR is made towards Dev branch and review the PR against the proejct and a set of pre-defined rules . So basically a  Programmatic Cursor SDK Pipeline

People have been building this very recently. I want it to be fully automated and in such a way that it can be configured for any repo under my organization. 

I want a custom solution instead of paying for a third party tool. I am already paying for cursor so I would prefer using @cursor/sdk

Please research thoroughly about how people are using @cursor/sdk for building these programmatic agents. 

You can check linkedIn and twitter because thats where most people have been talking about building these and also the actual @cursor/sdk blogs and  documentation. 


Before starting to build it let's first plan out everything involved so once we have the idea clear we can move onto the development part



Q: How should the orchestrator be deployed?
A: Express HTTP server (receives GitHub webhooks directly)

Q: Where should review rules / config live?
A: Both — central defaults + per-repo overrides (layered)

Q: What should the agent output to GitHub? (Select all that apply)
A: PR summary comment (top-level), Inline line-level comments on the diff, GitHub check (pass/fail that can block merge)


The review should be against the dev branch of the project so that the agent can review the PR against the current code architecture and maintain consistency with the project while also verifying it against the rules set in the rules file. 