import { EventEmitter } from "node:events";

function createDeferredQueue() {
  const entries = [];
  return {
    push(entry) {
      entries.push(entry);
      entries.sort((left, right) => left.at - right.at || left.id - right.id);
    },
    shiftDue(now) {
      const due = [];
      while (entries.length > 0 && entries[0].at <= now) {
        due.push(entries.shift());
      }
      return due;
    },
    remove(id) {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        entries.splice(index, 1);
      }
    },
    get size() {
      return entries.length;
    }
  };
}

export function createMockTimerAdapter() {
  let now = 0;
  let nextId = 1;
  const queue = createDeferredQueue();

  function schedule(callback, delayMs = 0) {
    const id = nextId++;
    queue.push({ id, at: now + Math.max(0, delayMs), callback });
    return id;
  }

  function cancel(id) {
    queue.remove(id);
  }

  function advance(ms = 0) {
    now += Math.max(0, ms);
    const due = queue.shiftDue(now);
    for (const entry of due) {
      entry.callback();
    }
  }

  return {
    schedule,
    cancel,
    advance,
    get now() {
      return now;
    },
    get pendingCount() {
      return queue.size;
    }
  };
}

export function createMockLoggerAdapter() {
  const entries = [];
  return {
    log(message, meta = {}) {
      entries.push({ message, meta });
    },
    entries
  };
}

export function createMockProcessAdapter() {
  const children = [];

  function spawn(command, cwd) {
    const child = new EventEmitter();
    child.command = command;
    child.cwd = cwd;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      if (child.killed) {
        return;
      }
      child.killed = true;
      child.emit("exit", null, "SIGTERM");
    };
    children.push(child);
    return child;
  }

  function terminate(child) {
    child?.kill?.();
  }

  return { spawn, terminate, children };
}

export function createMockWebSocketAdapter() {
  const sent = [];
  const socket = new EventEmitter();
  socket.closed = false;
  socket.send = (payload) => {
    sent.push(payload);
  };
  socket.close = () => {
    if (socket.closed) {
      return;
    }
    socket.closed = true;
    socket.emit("close");
  };

  return {
    socket,
    sent,
    connect(target, handlers) {
      const connection = target ?? socket;
      connection.on("message", handlers.message);
      connection.on("close", handlers.close);
      connection.on("error", handlers.error);
      return () => {
        connection.off("message", handlers.message);
        connection.off("close", handlers.close);
        connection.off("error", handlers.error);
      };
    },
    send(target, message) {
      target.send(JSON.stringify(message));
    },
    close(target) {
      target.close();
    },
    emitMessage(value) {
      socket.emit("message", value);
    },
    emitError(error) {
      socket.emit("error", error);
    }
  };
}
