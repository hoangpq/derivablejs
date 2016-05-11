'use strict';

var keys = Object.keys;

function assignPolyfill (obj) {
  for (var i = 1; i < arguments.length; i++) {
    var other = arguments[i];
    var ks = keys(other || {});
    for (var j = ks.length; j--;) {
      var prop = ks[j];
      obj[prop] = other[prop];
    }
  }
  return obj;
}

var assign = Object.assign;

if (!assign) {
  assign = assignPolyfill;
}

function _is(a, b) {
  // SameValue algorithm
  if (a === b) { // Steps 1-5, 7-10
    // Steps 6.b-6.e: +0 != -0
    return a !== 0 || 1 / a === 1 / b;
  } else {
    // Step 6.a: NaN == NaN
    return a !== a && b !== b;
  }
}

function equals (a, b) {
  return _is(a, b) || (a && typeof a.equals === 'function' && a.equals(b));
};

function addToArray (a, b) {
  var i = a.indexOf(b);
  if (i < 0) {
    a.push(b);
  }
};

function removeFromArray (a, b) {
  var i = a.indexOf(b);
  if (i >= 0) {
    a.splice(i, 1);
  }
};

var _nextId = 0;
function nextId () {
  return _nextId++;
};

function slice (a, i) {
  return Array.prototype.slice.call(a, i);
};

var unique = Object.freeze({equals: function () { return false; }});

function some (x) {
  return (x !== null) && (x !== void 0);
};

var DEBUG_MODE = false;
function setDebugMode (val) {
  DEBUG_MODE = !!val;
};

function setEquals (derivable, equals) {
  derivable._equals = equals;
  return derivable;
};

var epoch = {globalEpoch: 0};

var ATOM = "ATOM";
var DERIVATION = "DERIVATION";
var LENS = "LENS";
var REACTOR = "REACTOR";

var TransactionAbortion = {};

function initiateAbortion() {
  throw TransactionAbortion;
}

function TransactionContext(parent) {
  this.parent = parent;
  this.id2txnAtom = {};
  this.globalEpoch = epoch.globalEpoch;
  this.modifiedAtoms = [];
}

var currentCtx = null;

function inTransaction () {
  return currentCtx !== null;
};

function transact (f) {
  beginTransaction();
  try {
    f.call(null, initiateAbortion);
  }
  catch (e) {
    abortTransaction();
    if (e !== TransactionAbortion) {
      throw e;
    }
    return;
  }
  commitTransaction();
};

function transaction (f) {
  return function () {
    var args = slice(arguments, 0);
    var that = this;
    var result;
    transact(function () {
      result = f.apply(that, args);
    });
    return result;
  };
};

function beginTransaction() {
  currentCtx = new TransactionContext(currentCtx);
}

function commitTransaction() {
  var ctx = currentCtx;
  currentCtx = ctx.parent;
  var reactors = [];
  var numReactors = 0;
  ctx.modifiedAtoms.forEach(function (a) {
    if (currentCtx !== null) {
      a.set(ctx.id2txnAtom[a._id]._value);
    }
    else {
      a._set(ctx.id2txnAtom[a._id]._value);
      numReactors = findReactors(a._activeChildren, reactors, numReactors);
    }
  });
  if (currentCtx === null) {
    epoch.globalEpoch = ctx.globalEpoch;
  } else {
    currentCtx.globalEpoch = ctx.globalEpoch;
  }
  reactors.forEach(function (r) {
    r._maybeReact();
  });
}

function abortTransaction() {
  var ctx = currentCtx;
  currentCtx = ctx.parent;
  if (currentCtx === null) {
    epoch.globalEpoch = ctx.globalEpoch + 1;
  }
  else {
    currentCtx.globalEpoch = ctx.globalEpoch + 1;
  }
}

function findReactors(children, reactors, i) {
  for (var j = 0, len = children.length; j < len; j++) {
    var child = children[j];
    if (child._type === REACTOR) {
      reactors[i++] = child;
    } else {
      i = findReactors(child._activeChildren, reactors, i);
    }
  }
  return i;
}

var _tickerRefCount = 0;

function ticker () {
  if (_tickerRefCount === 0) {
    beginTransaction();
  }
  _tickerRefCount++;
  var done = false;
  return {
    tick: function () {
      if (done) throw new Error('trying to use ticker after release');
      commitTransaction();
      beginTransaction();
    },
    reset: function () {
      if (done) throw new Error('trying to use ticker after release');
      abortTransaction();
      beginTransaction();
    },
    release: function () {
      if (done) throw new Error('ticker already released');
      _tickerRefCount--;
      done = true;
      if (_tickerRefCount === 0) {
        commitTransaction();
      }
    },
  };
};

var parentsStack = [];

function capturingParentsEpochs (f) {
  var i = parentsStack.length;
  parentsStack.push([]);
  try {
    f();
    return parentsStack[i];
  } finally {
    parentsStack.pop();
  }
};

function captureParent (p) {
  if (parentsStack.length > 0) {
    var top = parentsStack[parentsStack.length - 1];
    top.push(p, 0);
    return top.length-1;
  } else {
    return -1;
  }
};

function captureEpoch (idx, epoch) {
  if (parentsStack.length > 0) {
    parentsStack[parentsStack.length - 1][idx] = epoch;
  }
};

function createPrototype (D, opts) {
  return {
    _clone: function () {
      return setEquals(D.atom(this._value), this._equals);
    },

    set: function (value) {
      if (currentCtx !== null) {
        // we are in a transaction!
        var inTxnThis = currentCtx.id2txnAtom[this._id];
        if (inTxnThis != null) {
          // we already have an in-txn verison of this atom, so update that
          if (!this.__equals(value, inTxnThis._value)) {
            inTxnThis._epoch++;
            currentCtx.globalEpoch++;
          }
          inTxnThis._value = value;
        } else {
          // look for other versions of this atom in higher txn layers
          var txnCtx = currentCtx.parent;
          while (txnCtx !== null) {
            inTxnThis = txnCtx.id2txnAtom[this._id];
            if (inTxnThis !== void 0) {
              // create new in-txn atom for this layer if need be
              if (!this.__equals(inTxnThis._value, value)) {
                var newInTxnThis = inTxnThis._clone();
                newInTxnThis._id = this._id;
                newInTxnThis._value = value;
                newInTxnThis._epoch = inTxnThis._epoch + 1;
                currentCtx.globalEpoch++;
                currentCtx.id2txnAtom[this._id] = newInTxnThis;
                addToArray(currentCtx.modifiedAtoms, this);
              }
              return;
            } else {
              txnCtx = txnCtx.parent;
            }
          }
          // no in-txn versions of this atom yet;
          currentCtx.globalEpoch++;
          inTxnThis = this._clone();
          inTxnThis._value = value;
          inTxnThis._id = this._id;
          inTxnThis._epoch = this._epoch + 1;
          currentCtx.id2txnAtom[this._id] = inTxnThis;
          addToArray(currentCtx.modifiedAtoms, this);
        }
      } else {
        // not in a transaction
        if (!this.__equals(value, this._value)) {
          this._set(value);
          this._reactorBuffer.length = findReactors(
            this._activeChildren, this._reactorBuffer, 0
          );

          for (var i = 0, len = this._reactorBuffer.length; i < len; i++) {
            var r = this._reactorBuffer[i];
            if (r._reacting) {
              // avoid more try...finally overhead
              this._reactorBuffer.length = 0;
              throw new Error('cyclical update detected');
            } else {
              r._maybeReact();
            }
          }

          this._reactorBuffer.length = 0;
        }
      }
    },

    _set: function (value) {
      epoch.globalEpoch++;
      this._epoch++;
      this._value = value;
    },

    get: function () {
      var inTxnThis;
      var txnCtx = currentCtx;
      while (txnCtx !== null) {
        inTxnThis = txnCtx.id2txnAtom[this._id];
        if (inTxnThis !== void 0) {
          captureEpoch(captureParent(this), inTxnThis._epoch);
          return inTxnThis._value;
        }
        else {
          txnCtx = txnCtx.parent;
        }
      }
      captureEpoch(captureParent(this), this._epoch);
      return this._value;
    },

    _getEpoch: function () {
      var inTxnThis;
      var txnCtx = currentCtx;
      while (txnCtx !== null) {
        inTxnThis = txnCtx.id2txnAtom[this._id];
        if (inTxnThis !== void 0) {
          return inTxnThis._epoch;
        }
        else {
          txnCtx = txnCtx.parent;
        }
      }
      return this._epoch;
    },

    _unlisten: function () {},
    _listen: function () {},
  };
};

function construct (atom, value) {
  atom._id = nextId();
  atom._activeChildren = [];
  atom._reactorBuffer = [];
  atom._epoch = 0;
  atom._value = value;
  atom._type = ATOM;
  atom._equals = null;
  atom._atoms = [atom];
  return atom;
};

var reactorParentStack = [];

function Reactor(react, derivable) {
  this._derivable = derivable;
  if (react) {
    this.react = react;
  }
  this._parent = null;
  this._active = false;
  this._yielding = false;
  this._reacting = false;
  this._type = REACTOR;

  if (DEBUG_MODE) {
    this.stack = Error().stack;
  }
}

assign(Reactor.prototype, {
  start: function () {
    this._lastValue = this._derivable.get();
    this._lastEpoch = this._derivable._epoch;

    addToArray(this._derivable._activeChildren, this);
    this._derivable._listen();

    var len = reactorParentStack.length;
    if (len > 0) {
      this._parent = reactorParentStack[len - 1];
    }
    this._active = true;
    this.onStart && this.onStart();
    return this;
  },
  _force: function (nextValue) {
    try {
      reactorParentStack.push(this);
      this._reacting = true;
      this.react(nextValue);

    } catch (e) {
      if (DEBUG_MODE) {
        console.error(this.stack);
      }
      throw e;
    } finally {
      this._reacting = false;
      reactorParentStack.pop();
    }
  },
  force: function () {
    this._force(this._derivable.get());

    return this;
  },
  _maybeReact: function () {
    if (!this._reacting && this._active) {
      if (this._yielding) {
        throw Error('reactor dependency cycle detected');
      }
      if (this._parent !== null) {
        this._yielding = true;
        try {
          this._parent._maybeReact();
        } finally {
          this._yielding = false;
        }
      }
      // maybe the reactor was stopped by the parent
      if (this._active) {
        var nextValue = this._derivable.get();
        if (this._derivable._epoch !== this._lastEpoch &&
            !this._derivable.__equals(nextValue, this._lastValue)) {
          this._force(nextValue);
        }

        this._lastEpoch = this._derivable._epoch;
        this._lastValue = nextValue;
      }
    }
  },
  stop: function () {
    removeFromArray(this._derivable._activeChildren, this);
    this._derivable._unlisten();

    this._parent = null;
    this._active = false;
    this.onStop && this.onStop();
    return this;
  },
  orphan: function () {
    this._parent = null;
    return this;
  },
  adopt: function (child) {
    child._parent = this;
    return this;
  },
  isActive: function () {
    return this._active;
  },
});

function createPrototype$1 (D, opts) {
  var x = {
    /**
     * Creates a derived value whose state will always be f applied to this
     * value
     */
    derive: function (f, a, b, c, d) {
      var that = this;
      switch (arguments.length) {
      case 0:
        throw new Error('.derive takes at least one argument');
      case 1:
        switch (typeof f) {
          case 'function':
            return D.derivation(function () {
              return f(that.get());
            });
          case 'string':
          case 'number':
            return D.derivation(function () {
              return that.get()[D.unpack(f)];
            });
          default:
            if (f instanceof Array) {
              return f.map(function (x) {
                return that.derive(x);
              });
            } else if (f instanceof RegExp) {
              return D.derivation(function () {
                return that.get().match(f);
              });
            } else if (D.isDerivable(f)) {
              return D.derivation(function () {
                var deriver = f.get();
                var thing = that.get();
                switch (typeof deriver) {
                  case 'function':
                    return deriver(thing);
                  case 'string':
                  case 'number':
                    return thing[deriver];
                  default:
                    if (deriver instanceof RegExp) {
                      return thing.match(deriver);
                    } else {
                      throw Error('type error');
                    }
                }
              });
            } else {
              throw Error('type error');
            }
        }
      case 2:
        return D.derivation(function () {
          return f(that.get(), D.unpack(a));
        });
      case 3:
        return D.derivation(function () {
          return f(that.get(), D.unpack(a), D.unpack(b));
        });
      case 4:
        return D.derivation(function () {
          return f(that.get(),
                   D.unpack(a),
                   D.unpack(b),
                   D.unpack(c));
        });
      case 5:
        return D.derivation(function () {
          return f(that.get(),
                   D.unpack(a),
                   D.unpack(b),
                   D.unpack(c),
                   D.unpack(d));
        });
      default:
        var args = ([that]).concat(slice(arguments, 1));
        return D.derivation(function () {
          return f.apply(null, args.map(D.unpack));
        });
      }
    },



    reactor: function (f) {
      if (typeof f === 'function') {
        return new Reactor(f, this);
      } else if (f instanceof Reactor) {
        if (typeof f.react !== 'function') {
          throw new Error('reactor missing .react method');
        }
        f._derivable = this;
        return f;
      } else if (f && f.react) {
        return assign(new Reactor(null, this), f);
      } else {
        throw new Error("Unrecognized type for reactor " + f);
      }
    },

    react: function (f, opts) {
      if (typeof f !== 'function') {
        throw Error('the first argument to .react must be a function');
      }

      opts = assign({
        once: false,
        from: true,
        until: false,
        when: true,
        skipFirst: false,
      }, opts);

      // coerce fn or bool to derivable<bool>
      function condDerivable(fOrD, name) {
        if (!D.isDerivable(fOrD)) {
          if (typeof fOrD === 'function') {
            fOrD = D.derivation(fOrD);
          } else if (typeof fOrD === 'boolean') {
            fOrD = D.atom(fOrD);
          } else {
            throw Error('react ' + name + ' condition must be derivable');
          }
        }
        return fOrD;
      }

      // wrap reactor so f doesn't get a .this context, and to allow
      // stopping after one reaction if desired.
      var reactor = this.reactor({
        react: function (val) {
          if (opts.skipFirst) {
            opts.skipFirst = false;
          } else {
            f(val);
            if (opts.once) {
              this.stop();
              controller.stop();
            }
          }
        },
        onStart: opts.onStart,
        onStop: opts.onStop
      });

      // listen to when and until conditions, starting and stopping the
      // reactor as appropriate, and stopping this controller when until
      // condition becomes true
      var controller = D.struct({
        until: condDerivable(opts.until, 'until'),
        when: condDerivable(opts.when, 'when')
      }).reactor(function (conds) {
        if (conds.until) {
          reactor.stop();
          this.stop();
        } else if (conds.when) {
          if (!reactor.isActive()) {
            reactor.start().force();
          }
        } else if (reactor.isActive()) {
          reactor.stop();
        }
      });

      // listen to from condition, starting the reactor controller
      // when appropriate
      condDerivable(opts.from, 'from').reactor(function (from) {
        if (from) {
          controller.start().force();
          this.stop();
        }
      }).start().force();
    },

    is: function (other) {
      return D.lift(this._equals || opts.equals)(this, other);
    },

    and: function (other) {
      return this.derive(function (x) {return x && D.unpack(other);});
    },

    or: function (other) {
      return this.derive(function (x) {return x || D.unpack(other);});
    },

    then: function (thenClause, elseClause) {
      return this.derive(function (x) {
        return D.unpack(x ? thenClause : elseClause);
      });
    },

    mThen: function (thenClause, elseClause) {
      return this.derive(function (x) {
        return D.unpack(some(x) ? thenClause : elseClause);
      });
    },

    mOr: function (other) {
      return this.mThen(this, other);
    },

    mDerive: function (arg) {
      if (arguments.length === 1 && arg instanceof Array) {
        var that = this;
        return arg.map(function (a) { return that.mDerive(a); });
      } else {
        return this.mThen(this.derive.apply(this, arguments));
      }
    },

    mAnd: function (other) {
      return this.mThen(other, this);
    },

    not: function () {
      return this.derive(function (x) { return !x; });
    },

    withEquality: function (equals) {
      if (equals) {
        if (typeof equals !== 'function') {
          throw new Error('equals must be function');
        }
      } else {
        equals = null;
      }

      return setEquals(this._clone(), equals);
    },

    __equals: function (a, b) {
      return (this._equals || opts.equals)(a, b);
    },
  };

  x.switch = function () {
    var args = arguments;
    return this.derive(function (x) {
      var i;
      for (i = 0; i < args.length-1; i+=2) {
        if (opts.equals(x, D.unpack(args[i]))) {
          return D.unpack(args[i+1]);
        }
      }
      if (i === args.length - 1) {
        return D.unpack(args[i]);
      }
    });
  };

  return x;
};

function createPrototype$2 (D, opts) {
  return {
    _clone: function () {
      return setEquals(D.derivation(this._deriver), this._equals);
    },

    _forceEval: function () {
      var that = this;
      var newVal = null;
      var capturedParentsEpochs = capturingParentsEpochs(function () {
        if (!DEBUG_MODE) {
          newVal = that._deriver();
        } else {
          try {
            newVal = that._deriver();
          } catch (e) {
            console.error(that.stack);
            throw e;
          }
        }
      });

      if (!this.__equals(newVal, this._value)) {
        this._epoch++;
      }

      if (this._refCount > 0) {
        var i = 0, j = 0;
        var oldLen = this._lastParentsEpochs.length;
        var newLen = capturedParentsEpochs.length;

        while (i < oldLen && j < newLen) {
          if (this._lastParentsEpochs[i] !== capturedParentsEpochs[j]) {
            break;
          } else {
            i += 2;
            j += 2;
          }
        }

        while (i < oldLen) {
          removeFromArray(this._lastParentsEpochs[i]._activeChildren, this);
          this._lastParentsEpochs[i]._unlisten();
          i += 2;
        }

        while (j < newLen) {
          addToArray(capturedParentsEpochs[j]._activeChildren, this);
          capturedParentsEpochs[j]._listen();
          j += 2;
        }
      }

      this._lastParentsEpochs = capturedParentsEpochs;
      this._value = newVal;
    },

    _update: function () {
      var globalEpoch = currentCtx === null ?
                         epoch.globalEpoch :
                         currentCtx.globalEpoch;
      if (this._lastGlobalEpoch !== globalEpoch) {
        if (this._value === unique) {
          // brand spanking new, so force eval
          this._forceEval();
        } else {
          for (var i = 0, len = this._lastParentsEpochs.length; i < len; i += 2) {
            var parent_1 = this._lastParentsEpochs[i];
            var lastParentEpoch = this._lastParentsEpochs[i + 1];
            var currentParentEpoch;
            if (parent_1._type === ATOM) {
              currentParentEpoch = parent_1._getEpoch();
            } else {
              parent_1._update();
              currentParentEpoch = parent_1._epoch;
            }
            if (currentParentEpoch !== lastParentEpoch) {
              this._forceEval();
              return;
            }
          }
        }
        this._lastGlobalEpoch = globalEpoch;
      }
    },

    get: function () {
      var idx = captureParent(this);
      this._update();
      captureEpoch(idx, this._epoch);
      return this._value;
    },

    _listen: function () {
      this._refCount++;
      for (var i = 0, len = this._lastParentsEpochs.length; i < len; i += 2) {
        var parent = this._lastParentsEpochs[i];
        if (this._refCount === 1) {
          // any compiler worth its salt will hoist this check of the loop
          addToArray(parent._activeChildren, this);
        }
        parent._listen();
      }
    },

    _unlisten: function () {
      this._refCount--;
      for (var i = 0, len = this._lastParentsEpochs.length; i < len; i += 2) {
        var parent = this._lastParentsEpochs[i];
        if (this._refCount === 0) {
          // any compiler worth its salt will hoist this check of the loop
          removeFromArray(parent._activeChildren, this);
        }
        parent._unlisten();
      }
    },
  };
};

function construct$1 (obj, deriver) {
  obj._deriver = deriver;
  obj._lastParentsEpochs = [];
  obj._lastGlobalEpoch = epoch.globalEpoch - 1;
  obj._epoch = 0;
  obj._type = DERIVATION;
  obj._value = unique;
  obj._equals = null;
  obj._activeChildren = [];
  obj._refCount = 0;

  if (DEBUG_MODE) {
    obj.stack = Error().stack;
  }

  return obj;
};

function createPrototype$3 (D, _) {
  return {
    swap: function (f) {
      var args = slice(arguments, 0);
      args[0] = this.get();
      return this.set(f.apply(null, args));
    },
    lens: function (monoLensDescriptor) {
      var that = this;
      return D.lens({
        get: function () {
          return monoLensDescriptor.get(that.get());
        },
        set: function (val) {
          that.set(monoLensDescriptor.set(that.get(), val));
        }
      });
    },
  };
};

function createPrototype$4 (D, _) {
  return {
    _clone: function () {
      return setEquals(D.lens(this._lensDescriptor), this._equals);
    },

    set: function (value) {
      var that = this;
      D.atomically(function () {
        that._lensDescriptor.set(value);
      });
      return this;
    },
  };
};

function construct$2 (derivation, descriptor) {
  derivation._lensDescriptor = descriptor;
  derivation._type = LENS;

  return derivation;
};

var defaultConfig = { equals: equals };

function constructModule (config) {
  config = assign({}, defaultConfig, config || {});

  var D = {
    transact: transact,
    defaultEquals: equals,
    setDebugMode: setDebugMode,
    transaction: transaction,
    ticker: ticker,
    Reactor: Reactor,
    isAtom: function (x) {
      return x && (x._type === ATOM || x._type === LENS);
    },
    isDerivable: function (x) {
      return x && (x._type === ATOM ||
                   x._type === LENS ||
                   x._type === DERIVATION);
    },
    isDerivation: function (x) {
      return x && (x._type === DERIVATION || x._type === LENS);
    },
    isLensed: function (x) {
      return x && x._type === LENS;
    },
    isReactor: function (x) {
      return x && x._type === REACTOR;
    },
  };

  var Derivable  = createPrototype$1(D, config);
  var Mutable    = createPrototype$3(D, config);

  var Atom       = assign({}, Mutable, Derivable,
                               createPrototype(D, config));

  var Derivation = assign({}, Derivable,
                               createPrototype$2(D, config));

  var Lens       = assign({}, Mutable, Derivation,
                              createPrototype$4(D, config));


  /**
   * Constructs a new atom whose state is the given value
   */
  D.atom = function (val) {
    return construct(Object.create(Atom), val);
  };

  /**
   * Returns a copy of f which runs atomically
   */
  D.atomic = function (f) {
    return function () {
      var result;
      var that = this;
      var args = arguments;
      D.atomically(function () {
        result = f.apply(that, args);
      });
      return result;
    };
  };

  D.atomically = function (f) {
    if (inTransaction()) {
      f();
    } else {
      D.transact(f);
    }
  };

  D.derivation = function (f) {
    return construct$1(Object.create(Derivation), f);
  };

  /**
   * Template string tag for derivable strings
   */
  D.derive = function (parts) {
    var args = slice(arguments, 1);
    return D.derivation(function () {
      var s = "";
      for (var i=0; i < parts.length; i++) {
        s += parts[i];
        if (i < args.length) {
          s += D.unpack(args[i]);
        }
      }
      return s;
    });
  };

  /**
   * creates a new lens
   */
  D.lens = function (descriptor) {
    return construct$2(
      construct$1(Object.create(Lens), descriptor.get),
      descriptor
    );
  };

  /**
   * dereferences a thing if it is dereferencable, otherwise just returns it.
   */
  D.unpack = function (thing) {
    if (D.isDerivable(thing)) {
      return thing.get();
    } else {
      return thing;
    }
  };

  /**
   * lifts a non-monadic function to work on derivables
   */
  D.lift = function (f) {
    return function () {
      var args = arguments;
      var that = this;
      return D.derivation(function () {
        return f.apply(that, Array.prototype.map.call(args, D.unpack));
      });
    };
  };

  function deepUnpack (thing) {
    if (D.isDerivable(thing)) {
      return thing.get();
    } else if (thing instanceof Array) {
      return thing.map(deepUnpack);
    } else if (thing.constructor === Object) {
      var result = {};
      var keys$$ = keys(thing);
      for (var i = keys$$.length; i--;) {
        var prop = keys$$[i];
        result[prop] = deepUnpack(thing[prop]);
      }
      return result;
    } else {
      return thing;
    }
  }

  D.struct = function (arg) {
    if (arg.constructor === Object || arg instanceof Array) {
      return D.derivation(function () {
        return deepUnpack(arg);
      });
    } else {
      throw new Error("`struct` expects plain Object or Array");
    }
  };

  function andOrFn (breakOn) {
    return function () {
      var args = arguments;
      return D.derivation(function () {
        var val;
        for (var i = 0; i < args.length; i++) {
          val = D.unpack(args[i]);
          if (breakOn(val)) {
            break;
          }
        }
        return val;
      });
    };
  }
  function identity (x) { return x; }
  function complement (f) { return function (x) { return !f(x); }; }
  D.or = andOrFn(identity);
  D.mOr = andOrFn(some);
  D.and = andOrFn(complement(identity));
  D.mAnd = andOrFn(complement(some));

  return D;
}

assign(exports, constructModule());
exports.withEquality = function (equals) {
  return constructModule({equals: equals});
};
exports['default'] = exports;
//# sourceMappingURL=derivable.js.map