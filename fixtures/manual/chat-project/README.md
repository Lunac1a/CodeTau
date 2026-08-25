# CodeTau manual chat fixture

This deliberately small project is for manually testing CodeTau's persistent
terminal conversation. Its email-normalization behavior starts with a bug, so
the first test run is expected to fail.

## Start

Start LM Studio and load the model configured in `codetau.config.json`. Then run:

```powershell
cd fixtures/manual/chat-project
pnpm test
pnpm codetau
```

Accept the detected `pnpm run test` validation command. The initial test failure
is intentional.

## Suggested conversation

First message:

```text
修复用户注册时邮箱没有标准化的问题。邮箱需要去除首尾空白并转成小写，重复检查也必须忽略大小写。保留现有公开 API 和其他行为。
```

Approve the source-file write. CodeTau should update
`src/user-directory.js`, rerun the tests, and report a passing delivery.

Second message, in the same terminal:

```text
刚才修改了什么？不要修改文件，检查当前实现并用简短中文回答。
```

Third message, to exercise file creation:

```text
新增 formatUser(user) 格式化函数，返回类似 "1: Ada <ada@example.com>" 的字符串；请创建新的源码文件和对应测试，不要修改现有测试。
```

Finally enter `:exit`, copy the Conversation ID, and resume it with:

```powershell
pnpm codetau -- chat --conversation <conversation-id>
```

Each completed turn also prints a Session ID. Inspect that individual run with:

```powershell
pnpm codetau -- status <session-id>
```
