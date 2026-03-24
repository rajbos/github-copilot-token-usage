"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __export = (target, all2) => {
    for (var name in all2)
      __defProp(target, name, { get: all2[name], enumerable: true });
  };

  // node_modules/@microsoft/fast-element/dist/esm/platform.js
  function createMetadataLocator() {
    const metadataLookup = /* @__PURE__ */ new WeakMap();
    return function(target) {
      let metadata = metadataLookup.get(target);
      if (metadata === void 0) {
        let currentTarget = Reflect.getPrototypeOf(target);
        while (metadata === void 0 && currentTarget !== null) {
          metadata = metadataLookup.get(currentTarget);
          currentTarget = Reflect.getPrototypeOf(currentTarget);
        }
        metadata = metadata === void 0 ? [] : metadata.slice(0);
        metadataLookup.set(target, metadata);
      }
      return metadata;
    };
  }
  var $global, propConfig, FAST, emptyArray;
  var init_platform = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/platform.js"() {
      $global = (function() {
        if (typeof globalThis !== "undefined") {
          return globalThis;
        }
        if (typeof global !== "undefined") {
          return global;
        }
        if (typeof self !== "undefined") {
          return self;
        }
        if (typeof window !== "undefined") {
          return window;
        }
        try {
          return new Function("return this")();
        } catch (_a) {
          return {};
        }
      })();
      if ($global.trustedTypes === void 0) {
        $global.trustedTypes = { createPolicy: (n, r) => r };
      }
      propConfig = {
        configurable: false,
        enumerable: false,
        writable: false
      };
      if ($global.FAST === void 0) {
        Reflect.defineProperty($global, "FAST", Object.assign({ value: /* @__PURE__ */ Object.create(null) }, propConfig));
      }
      FAST = $global.FAST;
      if (FAST.getById === void 0) {
        const storage = /* @__PURE__ */ Object.create(null);
        Reflect.defineProperty(FAST, "getById", Object.assign({ value(id, initialize) {
          let found = storage[id];
          if (found === void 0) {
            found = initialize ? storage[id] = initialize() : null;
          }
          return found;
        } }, propConfig));
      }
      emptyArray = Object.freeze([]);
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/dom.js
  var updateQueue, fastHTMLPolicy, htmlPolicy, marker, _interpolationStart, _interpolationEnd, DOM;
  var init_dom = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/dom.js"() {
      init_platform();
      updateQueue = $global.FAST.getById(1, () => {
        const tasks = [];
        const pendingErrors = [];
        function throwFirstError() {
          if (pendingErrors.length) {
            throw pendingErrors.shift();
          }
        }
        function tryRunTask(task) {
          try {
            task.call();
          } catch (error) {
            pendingErrors.push(error);
            setTimeout(throwFirstError, 0);
          }
        }
        function process() {
          const capacity = 1024;
          let index = 0;
          while (index < tasks.length) {
            tryRunTask(tasks[index]);
            index++;
            if (index > capacity) {
              for (let scan = 0, newLength = tasks.length - index; scan < newLength; scan++) {
                tasks[scan] = tasks[scan + index];
              }
              tasks.length -= index;
              index = 0;
            }
          }
          tasks.length = 0;
        }
        function enqueue(callable) {
          if (tasks.length < 1) {
            $global.requestAnimationFrame(process);
          }
          tasks.push(callable);
        }
        return Object.freeze({
          enqueue,
          process
        });
      });
      fastHTMLPolicy = $global.trustedTypes.createPolicy("fast-html", {
        createHTML: (html2) => html2
      });
      htmlPolicy = fastHTMLPolicy;
      marker = `fast-${Math.random().toString(36).substring(2, 8)}`;
      _interpolationStart = `${marker}{`;
      _interpolationEnd = `}${marker}`;
      DOM = Object.freeze({
        /**
         * Indicates whether the DOM supports the adoptedStyleSheets feature.
         */
        supportsAdoptedStyleSheets: Array.isArray(document.adoptedStyleSheets) && "replace" in CSSStyleSheet.prototype,
        /**
         * Sets the HTML trusted types policy used by the templating engine.
         * @param policy - The policy to set for HTML.
         * @remarks
         * This API can only be called once, for security reasons. It should be
         * called by the application developer at the start of their program.
         */
        setHTMLPolicy(policy) {
          if (htmlPolicy !== fastHTMLPolicy) {
            throw new Error("The HTML policy can only be set once.");
          }
          htmlPolicy = policy;
        },
        /**
         * Turns a string into trusted HTML using the configured trusted types policy.
         * @param html - The string to turn into trusted HTML.
         * @remarks
         * Used internally by the template engine when creating templates
         * and setting innerHTML.
         */
        createHTML(html2) {
          return htmlPolicy.createHTML(html2);
        },
        /**
         * Determines if the provided node is a template marker used by the runtime.
         * @param node - The node to test.
         */
        isMarker(node) {
          return node && node.nodeType === 8 && node.data.startsWith(marker);
        },
        /**
         * Given a marker node, extract the {@link HTMLDirective} index from the placeholder.
         * @param node - The marker node to extract the index from.
         */
        extractDirectiveIndexFromMarker(node) {
          return parseInt(node.data.replace(`${marker}:`, ""));
        },
        /**
         * Creates a placeholder string suitable for marking out a location *within*
         * an attribute value or HTML content.
         * @param index - The directive index to create the placeholder for.
         * @remarks
         * Used internally by binding directives.
         */
        createInterpolationPlaceholder(index) {
          return `${_interpolationStart}${index}${_interpolationEnd}`;
        },
        /**
         * Creates a placeholder that manifests itself as an attribute on an
         * element.
         * @param attributeName - The name of the custom attribute.
         * @param index - The directive index to create the placeholder for.
         * @remarks
         * Used internally by attribute directives such as `ref`, `slotted`, and `children`.
         */
        createCustomAttributePlaceholder(attributeName, index) {
          return `${attributeName}="${this.createInterpolationPlaceholder(index)}"`;
        },
        /**
         * Creates a placeholder that manifests itself as a marker within the DOM structure.
         * @param index - The directive index to create the placeholder for.
         * @remarks
         * Used internally by structural directives such as `repeat`.
         */
        createBlockPlaceholder(index) {
          return `<!--${marker}:${index}-->`;
        },
        /**
         * Schedules DOM update work in the next async batch.
         * @param callable - The callable function or object to queue.
         */
        queueUpdate: updateQueue.enqueue,
        /**
         * Immediately processes all work previously scheduled
         * through queueUpdate.
         * @remarks
         * This also forces nextUpdate promises
         * to resolve.
         */
        processUpdates: updateQueue.process,
        /**
         * Resolves with the next DOM update.
         */
        nextUpdate() {
          return new Promise(updateQueue.enqueue);
        },
        /**
         * Sets an attribute value on an element.
         * @param element - The element to set the attribute value on.
         * @param attributeName - The attribute name to set.
         * @param value - The value of the attribute to set.
         * @remarks
         * If the value is `null` or `undefined`, the attribute is removed, otherwise
         * it is set to the provided value using the standard `setAttribute` API.
         */
        setAttribute(element, attributeName, value) {
          if (value === null || value === void 0) {
            element.removeAttribute(attributeName);
          } else {
            element.setAttribute(attributeName, value);
          }
        },
        /**
         * Sets a boolean attribute value.
         * @param element - The element to set the boolean attribute value on.
         * @param attributeName - The attribute name to set.
         * @param value - The value of the attribute to set.
         * @remarks
         * If the value is true, the attribute is added; otherwise it is removed.
         */
        setBooleanAttribute(element, attributeName, value) {
          value ? element.setAttribute(attributeName, "") : element.removeAttribute(attributeName);
        },
        /**
         * Removes all the child nodes of the provided parent node.
         * @param parent - The node to remove the children from.
         */
        removeChildNodes(parent) {
          for (let child = parent.firstChild; child !== null; child = parent.firstChild) {
            parent.removeChild(child);
          }
        },
        /**
         * Creates a TreeWalker configured to walk a template fragment.
         * @param fragment - The fragment to walk.
         */
        createTemplateWalker(fragment) {
          return document.createTreeWalker(
            fragment,
            133,
            // element, text, comment
            null,
            false
          );
        }
      });
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/observation/notifier.js
  var SubscriberSet, PropertyChangeNotifier;
  var init_notifier = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/observation/notifier.js"() {
      SubscriberSet = class {
        /**
         * Creates an instance of SubscriberSet for the specified source.
         * @param source - The object source that subscribers will receive notifications from.
         * @param initialSubscriber - An initial subscriber to changes.
         */
        constructor(source, initialSubscriber) {
          this.sub1 = void 0;
          this.sub2 = void 0;
          this.spillover = void 0;
          this.source = source;
          this.sub1 = initialSubscriber;
        }
        /**
         * Checks whether the provided subscriber has been added to this set.
         * @param subscriber - The subscriber to test for inclusion in this set.
         */
        has(subscriber) {
          return this.spillover === void 0 ? this.sub1 === subscriber || this.sub2 === subscriber : this.spillover.indexOf(subscriber) !== -1;
        }
        /**
         * Subscribes to notification of changes in an object's state.
         * @param subscriber - The object that is subscribing for change notification.
         */
        subscribe(subscriber) {
          const spillover = this.spillover;
          if (spillover === void 0) {
            if (this.has(subscriber)) {
              return;
            }
            if (this.sub1 === void 0) {
              this.sub1 = subscriber;
              return;
            }
            if (this.sub2 === void 0) {
              this.sub2 = subscriber;
              return;
            }
            this.spillover = [this.sub1, this.sub2, subscriber];
            this.sub1 = void 0;
            this.sub2 = void 0;
          } else {
            const index = spillover.indexOf(subscriber);
            if (index === -1) {
              spillover.push(subscriber);
            }
          }
        }
        /**
         * Unsubscribes from notification of changes in an object's state.
         * @param subscriber - The object that is unsubscribing from change notification.
         */
        unsubscribe(subscriber) {
          const spillover = this.spillover;
          if (spillover === void 0) {
            if (this.sub1 === subscriber) {
              this.sub1 = void 0;
            } else if (this.sub2 === subscriber) {
              this.sub2 = void 0;
            }
          } else {
            const index = spillover.indexOf(subscriber);
            if (index !== -1) {
              spillover.splice(index, 1);
            }
          }
        }
        /**
         * Notifies all subscribers.
         * @param args - Data passed along to subscribers during notification.
         */
        notify(args) {
          const spillover = this.spillover;
          const source = this.source;
          if (spillover === void 0) {
            const sub1 = this.sub1;
            const sub2 = this.sub2;
            if (sub1 !== void 0) {
              sub1.handleChange(source, args);
            }
            if (sub2 !== void 0) {
              sub2.handleChange(source, args);
            }
          } else {
            for (let i = 0, ii = spillover.length; i < ii; ++i) {
              spillover[i].handleChange(source, args);
            }
          }
        }
      };
      PropertyChangeNotifier = class {
        /**
         * Creates an instance of PropertyChangeNotifier for the specified source.
         * @param source - The object source that subscribers will receive notifications from.
         */
        constructor(source) {
          this.subscribers = {};
          this.sourceSubscribers = null;
          this.source = source;
        }
        /**
         * Notifies all subscribers, based on the specified property.
         * @param propertyName - The property name, passed along to subscribers during notification.
         */
        notify(propertyName) {
          var _a;
          const subscribers = this.subscribers[propertyName];
          if (subscribers !== void 0) {
            subscribers.notify(propertyName);
          }
          (_a = this.sourceSubscribers) === null || _a === void 0 ? void 0 : _a.notify(propertyName);
        }
        /**
         * Subscribes to notification of changes in an object's state.
         * @param subscriber - The object that is subscribing for change notification.
         * @param propertyToWatch - The name of the property that the subscriber is interested in watching for changes.
         */
        subscribe(subscriber, propertyToWatch) {
          var _a;
          if (propertyToWatch) {
            let subscribers = this.subscribers[propertyToWatch];
            if (subscribers === void 0) {
              this.subscribers[propertyToWatch] = subscribers = new SubscriberSet(this.source);
            }
            subscribers.subscribe(subscriber);
          } else {
            this.sourceSubscribers = (_a = this.sourceSubscribers) !== null && _a !== void 0 ? _a : new SubscriberSet(this.source);
            this.sourceSubscribers.subscribe(subscriber);
          }
        }
        /**
         * Unsubscribes from notification of changes in an object's state.
         * @param subscriber - The object that is unsubscribing from change notification.
         * @param propertyToUnwatch - The name of the property that the subscriber is no longer interested in watching.
         */
        unsubscribe(subscriber, propertyToUnwatch) {
          var _a;
          if (propertyToUnwatch) {
            const subscribers = this.subscribers[propertyToUnwatch];
            if (subscribers !== void 0) {
              subscribers.unsubscribe(subscriber);
            }
          } else {
            (_a = this.sourceSubscribers) === null || _a === void 0 ? void 0 : _a.unsubscribe(subscriber);
          }
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/observation/observable.js
  function observable(target, nameOrAccessor) {
    Observable.defineProperty(target, nameOrAccessor);
  }
  function volatile(target, name, descriptor) {
    return Object.assign({}, descriptor, {
      get: function() {
        Observable.trackVolatile();
        return descriptor.get.apply(this);
      }
    });
  }
  var Observable, contextEvent, ExecutionContext, defaultExecutionContext;
  var init_observable = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/observation/observable.js"() {
      init_dom();
      init_platform();
      init_notifier();
      Observable = FAST.getById(2, () => {
        const volatileRegex = /(:|&&|\|\||if)/;
        const notifierLookup = /* @__PURE__ */ new WeakMap();
        const queueUpdate = DOM.queueUpdate;
        let watcher = void 0;
        let createArrayObserver = (array) => {
          throw new Error("Must call enableArrayObservation before observing arrays.");
        };
        function getNotifier(source) {
          let found = source.$fastController || notifierLookup.get(source);
          if (found === void 0) {
            if (Array.isArray(source)) {
              found = createArrayObserver(source);
            } else {
              notifierLookup.set(source, found = new PropertyChangeNotifier(source));
            }
          }
          return found;
        }
        const getAccessors = createMetadataLocator();
        class DefaultObservableAccessor {
          constructor(name) {
            this.name = name;
            this.field = `_${name}`;
            this.callback = `${name}Changed`;
          }
          getValue(source) {
            if (watcher !== void 0) {
              watcher.watch(source, this.name);
            }
            return source[this.field];
          }
          setValue(source, newValue) {
            const field = this.field;
            const oldValue = source[field];
            if (oldValue !== newValue) {
              source[field] = newValue;
              const callback = source[this.callback];
              if (typeof callback === "function") {
                callback.call(source, oldValue, newValue);
              }
              getNotifier(source).notify(this.name);
            }
          }
        }
        class BindingObserverImplementation extends SubscriberSet {
          constructor(binding, initialSubscriber, isVolatileBinding = false) {
            super(binding, initialSubscriber);
            this.binding = binding;
            this.isVolatileBinding = isVolatileBinding;
            this.needsRefresh = true;
            this.needsQueue = true;
            this.first = this;
            this.last = null;
            this.propertySource = void 0;
            this.propertyName = void 0;
            this.notifier = void 0;
            this.next = void 0;
          }
          observe(source, context) {
            if (this.needsRefresh && this.last !== null) {
              this.disconnect();
            }
            const previousWatcher = watcher;
            watcher = this.needsRefresh ? this : void 0;
            this.needsRefresh = this.isVolatileBinding;
            const result = this.binding(source, context);
            watcher = previousWatcher;
            return result;
          }
          disconnect() {
            if (this.last !== null) {
              let current = this.first;
              while (current !== void 0) {
                current.notifier.unsubscribe(this, current.propertyName);
                current = current.next;
              }
              this.last = null;
              this.needsRefresh = this.needsQueue = true;
            }
          }
          watch(propertySource, propertyName) {
            const prev = this.last;
            const notifier = getNotifier(propertySource);
            const current = prev === null ? this.first : {};
            current.propertySource = propertySource;
            current.propertyName = propertyName;
            current.notifier = notifier;
            notifier.subscribe(this, propertyName);
            if (prev !== null) {
              if (!this.needsRefresh) {
                let prevValue;
                watcher = void 0;
                prevValue = prev.propertySource[prev.propertyName];
                watcher = this;
                if (propertySource === prevValue) {
                  this.needsRefresh = true;
                }
              }
              prev.next = current;
            }
            this.last = current;
          }
          handleChange() {
            if (this.needsQueue) {
              this.needsQueue = false;
              queueUpdate(this);
            }
          }
          call() {
            if (this.last !== null) {
              this.needsQueue = true;
              this.notify(this);
            }
          }
          records() {
            let next = this.first;
            return {
              next: () => {
                const current = next;
                if (current === void 0) {
                  return { value: void 0, done: true };
                } else {
                  next = next.next;
                  return {
                    value: current,
                    done: false
                  };
                }
              },
              [Symbol.iterator]: function() {
                return this;
              }
            };
          }
        }
        return Object.freeze({
          /**
           * @internal
           * @param factory - The factory used to create array observers.
           */
          setArrayObserverFactory(factory) {
            createArrayObserver = factory;
          },
          /**
           * Gets a notifier for an object or Array.
           * @param source - The object or Array to get the notifier for.
           */
          getNotifier,
          /**
           * Records a property change for a source object.
           * @param source - The object to record the change against.
           * @param propertyName - The property to track as changed.
           */
          track(source, propertyName) {
            if (watcher !== void 0) {
              watcher.watch(source, propertyName);
            }
          },
          /**
           * Notifies watchers that the currently executing property getter or function is volatile
           * with respect to its observable dependencies.
           */
          trackVolatile() {
            if (watcher !== void 0) {
              watcher.needsRefresh = true;
            }
          },
          /**
           * Notifies subscribers of a source object of changes.
           * @param source - the object to notify of changes.
           * @param args - The change args to pass to subscribers.
           */
          notify(source, args) {
            getNotifier(source).notify(args);
          },
          /**
           * Defines an observable property on an object or prototype.
           * @param target - The target object to define the observable on.
           * @param nameOrAccessor - The name of the property to define as observable;
           * or a custom accessor that specifies the property name and accessor implementation.
           */
          defineProperty(target, nameOrAccessor) {
            if (typeof nameOrAccessor === "string") {
              nameOrAccessor = new DefaultObservableAccessor(nameOrAccessor);
            }
            getAccessors(target).push(nameOrAccessor);
            Reflect.defineProperty(target, nameOrAccessor.name, {
              enumerable: true,
              get: function() {
                return nameOrAccessor.getValue(this);
              },
              set: function(newValue) {
                nameOrAccessor.setValue(this, newValue);
              }
            });
          },
          /**
           * Finds all the observable accessors defined on the target,
           * including its prototype chain.
           * @param target - The target object to search for accessor on.
           */
          getAccessors,
          /**
           * Creates a {@link BindingObserver} that can watch the
           * provided {@link Binding} for changes.
           * @param binding - The binding to observe.
           * @param initialSubscriber - An initial subscriber to changes in the binding value.
           * @param isVolatileBinding - Indicates whether the binding's dependency list must be re-evaluated on every value evaluation.
           */
          binding(binding, initialSubscriber, isVolatileBinding = this.isVolatileBinding(binding)) {
            return new BindingObserverImplementation(binding, initialSubscriber, isVolatileBinding);
          },
          /**
           * Determines whether a binding expression is volatile and needs to have its dependency list re-evaluated
           * on every evaluation of the value.
           * @param binding - The binding to inspect.
           */
          isVolatileBinding(binding) {
            return volatileRegex.test(binding.toString());
          }
        });
      });
      contextEvent = FAST.getById(3, () => {
        let current = null;
        return {
          get() {
            return current;
          },
          set(event) {
            current = event;
          }
        };
      });
      ExecutionContext = class {
        constructor() {
          this.index = 0;
          this.length = 0;
          this.parent = null;
          this.parentContext = null;
        }
        /**
         * The current event within an event handler.
         */
        get event() {
          return contextEvent.get();
        }
        /**
         * Indicates whether the current item within a repeat context
         * has an even index.
         */
        get isEven() {
          return this.index % 2 === 0;
        }
        /**
         * Indicates whether the current item within a repeat context
         * has an odd index.
         */
        get isOdd() {
          return this.index % 2 !== 0;
        }
        /**
         * Indicates whether the current item within a repeat context
         * is the first item in the collection.
         */
        get isFirst() {
          return this.index === 0;
        }
        /**
         * Indicates whether the current item within a repeat context
         * is somewhere in the middle of the collection.
         */
        get isInMiddle() {
          return !this.isFirst && !this.isLast;
        }
        /**
         * Indicates whether the current item within a repeat context
         * is the last item in the collection.
         */
        get isLast() {
          return this.index === this.length - 1;
        }
        /**
         * Sets the event for the current execution context.
         * @param event - The event to set.
         * @internal
         */
        static setEvent(event) {
          contextEvent.set(event);
        }
      };
      Observable.defineProperty(ExecutionContext.prototype, "index");
      Observable.defineProperty(ExecutionContext.prototype, "length");
      defaultExecutionContext = Object.seal(new ExecutionContext());
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/templating/html-directive.js
  var HTMLDirective, TargetedHTMLDirective, AttachedBehaviorHTMLDirective;
  var init_html_directive = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/templating/html-directive.js"() {
      init_dom();
      HTMLDirective = class {
        constructor() {
          this.targetIndex = 0;
        }
      };
      TargetedHTMLDirective = class extends HTMLDirective {
        constructor() {
          super(...arguments);
          this.createPlaceholder = DOM.createInterpolationPlaceholder;
        }
      };
      AttachedBehaviorHTMLDirective = class extends HTMLDirective {
        /**
         *
         * @param name - The name of the behavior; used as a custom attribute on the element.
         * @param behavior - The behavior to instantiate and attach to the element.
         * @param options - Options to pass to the behavior during creation.
         */
        constructor(name, behavior, options) {
          super();
          this.name = name;
          this.behavior = behavior;
          this.options = options;
        }
        /**
         * Creates a placeholder string based on the directive's index within the template.
         * @param index - The index of the directive within the template.
         * @remarks
         * Creates a custom attribute placeholder.
         */
        createPlaceholder(index) {
          return DOM.createCustomAttributePlaceholder(this.name, index);
        }
        /**
         * Creates a behavior for the provided target node.
         * @param target - The node instance to create the behavior for.
         * @remarks
         * Creates an instance of the `behavior` type this directive was constructed with
         * and passes the target and options to that `behavior`'s constructor.
         */
        createBehavior(target) {
          return new this.behavior(target, this.options);
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/templating/binding.js
  function normalBind(source, context) {
    this.source = source;
    this.context = context;
    if (this.bindingObserver === null) {
      this.bindingObserver = Observable.binding(this.binding, this, this.isBindingVolatile);
    }
    this.updateTarget(this.bindingObserver.observe(source, context));
  }
  function triggerBind(source, context) {
    this.source = source;
    this.context = context;
    this.target.addEventListener(this.targetName, this);
  }
  function normalUnbind() {
    this.bindingObserver.disconnect();
    this.source = null;
    this.context = null;
  }
  function contentUnbind() {
    this.bindingObserver.disconnect();
    this.source = null;
    this.context = null;
    const view = this.target.$fastView;
    if (view !== void 0 && view.isComposed) {
      view.unbind();
      view.needsBindOnly = true;
    }
  }
  function triggerUnbind() {
    this.target.removeEventListener(this.targetName, this);
    this.source = null;
    this.context = null;
  }
  function updateAttributeTarget(value) {
    DOM.setAttribute(this.target, this.targetName, value);
  }
  function updateBooleanAttributeTarget(value) {
    DOM.setBooleanAttribute(this.target, this.targetName, value);
  }
  function updateContentTarget(value) {
    if (value === null || value === void 0) {
      value = "";
    }
    if (value.create) {
      this.target.textContent = "";
      let view = this.target.$fastView;
      if (view === void 0) {
        view = value.create();
      } else {
        if (this.target.$fastTemplate !== value) {
          if (view.isComposed) {
            view.remove();
            view.unbind();
          }
          view = value.create();
        }
      }
      if (!view.isComposed) {
        view.isComposed = true;
        view.bind(this.source, this.context);
        view.insertBefore(this.target);
        this.target.$fastView = view;
        this.target.$fastTemplate = value;
      } else if (view.needsBindOnly) {
        view.needsBindOnly = false;
        view.bind(this.source, this.context);
      }
    } else {
      const view = this.target.$fastView;
      if (view !== void 0 && view.isComposed) {
        view.isComposed = false;
        view.remove();
        if (view.needsBindOnly) {
          view.needsBindOnly = false;
        } else {
          view.unbind();
        }
      }
      this.target.textContent = value;
    }
  }
  function updatePropertyTarget(value) {
    this.target[this.targetName] = value;
  }
  function updateClassTarget(value) {
    const classVersions = this.classVersions || /* @__PURE__ */ Object.create(null);
    const target = this.target;
    let version = this.version || 0;
    if (value !== null && value !== void 0 && value.length) {
      const names = value.split(/\s+/);
      for (let i = 0, ii = names.length; i < ii; ++i) {
        const currentName = names[i];
        if (currentName === "") {
          continue;
        }
        classVersions[currentName] = version;
        target.classList.add(currentName);
      }
    }
    this.classVersions = classVersions;
    this.version = version + 1;
    if (version === 0) {
      return;
    }
    version -= 1;
    for (const name in classVersions) {
      if (classVersions[name] === version) {
        target.classList.remove(name);
      }
    }
  }
  var HTMLBindingDirective, BindingBehavior;
  var init_binding = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/templating/binding.js"() {
      init_dom();
      init_observable();
      init_html_directive();
      HTMLBindingDirective = class extends TargetedHTMLDirective {
        /**
         * Creates an instance of BindingDirective.
         * @param binding - A binding that returns the data used to update the DOM.
         */
        constructor(binding) {
          super();
          this.binding = binding;
          this.bind = normalBind;
          this.unbind = normalUnbind;
          this.updateTarget = updateAttributeTarget;
          this.isBindingVolatile = Observable.isVolatileBinding(this.binding);
        }
        /**
         * Gets/sets the name of the attribute or property that this
         * binding is targeting.
         */
        get targetName() {
          return this.originalTargetName;
        }
        set targetName(value) {
          this.originalTargetName = value;
          if (value === void 0) {
            return;
          }
          switch (value[0]) {
            case ":":
              this.cleanedTargetName = value.substr(1);
              this.updateTarget = updatePropertyTarget;
              if (this.cleanedTargetName === "innerHTML") {
                const binding = this.binding;
                this.binding = (s, c) => DOM.createHTML(binding(s, c));
              }
              break;
            case "?":
              this.cleanedTargetName = value.substr(1);
              this.updateTarget = updateBooleanAttributeTarget;
              break;
            case "@":
              this.cleanedTargetName = value.substr(1);
              this.bind = triggerBind;
              this.unbind = triggerUnbind;
              break;
            default:
              this.cleanedTargetName = value;
              if (value === "class") {
                this.updateTarget = updateClassTarget;
              }
              break;
          }
        }
        /**
         * Makes this binding target the content of an element rather than
         * a particular attribute or property.
         */
        targetAtContent() {
          this.updateTarget = updateContentTarget;
          this.unbind = contentUnbind;
        }
        /**
         * Creates the runtime BindingBehavior instance based on the configuration
         * information stored in the BindingDirective.
         * @param target - The target node that the binding behavior should attach to.
         */
        createBehavior(target) {
          return new BindingBehavior(target, this.binding, this.isBindingVolatile, this.bind, this.unbind, this.updateTarget, this.cleanedTargetName);
        }
      };
      BindingBehavior = class {
        /**
         * Creates an instance of BindingBehavior.
         * @param target - The target of the data updates.
         * @param binding - The binding that returns the latest value for an update.
         * @param isBindingVolatile - Indicates whether the binding has volatile dependencies.
         * @param bind - The operation to perform during binding.
         * @param unbind - The operation to perform during unbinding.
         * @param updateTarget - The operation to perform when updating.
         * @param targetName - The name of the target attribute or property to update.
         */
        constructor(target, binding, isBindingVolatile, bind, unbind, updateTarget, targetName) {
          this.source = null;
          this.context = null;
          this.bindingObserver = null;
          this.target = target;
          this.binding = binding;
          this.isBindingVolatile = isBindingVolatile;
          this.bind = bind;
          this.unbind = unbind;
          this.updateTarget = updateTarget;
          this.targetName = targetName;
        }
        /** @internal */
        handleChange() {
          this.updateTarget(this.bindingObserver.observe(this.source, this.context));
        }
        /** @internal */
        handleEvent(event) {
          ExecutionContext.setEvent(event);
          const result = this.binding(this.source, this.context);
          ExecutionContext.setEvent(null);
          if (result !== true) {
            event.preventDefault();
          }
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/templating/compiler.js
  function createAggregateBinding(parts) {
    if (parts.length === 1) {
      return parts[0];
    }
    let targetName;
    const partCount = parts.length;
    const finalParts = parts.map((x) => {
      if (typeof x === "string") {
        return () => x;
      }
      targetName = x.targetName || targetName;
      return x.binding;
    });
    const binding = (scope, context) => {
      let output = "";
      for (let i = 0; i < partCount; ++i) {
        output += finalParts[i](scope, context);
      }
      return output;
    };
    const directive = new HTMLBindingDirective(binding);
    directive.targetName = targetName;
    return directive;
  }
  function parseContent(context, value) {
    const valueParts = value.split(_interpolationStart);
    if (valueParts.length === 1) {
      return null;
    }
    const bindingParts = [];
    for (let i = 0, ii = valueParts.length; i < ii; ++i) {
      const current = valueParts[i];
      const index = current.indexOf(_interpolationEnd);
      let literal;
      if (index === -1) {
        literal = current;
      } else {
        const directiveIndex = parseInt(current.substring(0, index));
        bindingParts.push(context.directives[directiveIndex]);
        literal = current.substring(index + interpolationEndLength);
      }
      if (literal !== "") {
        bindingParts.push(literal);
      }
    }
    return bindingParts;
  }
  function compileAttributes(context, node, includeBasicValues = false) {
    const attributes = node.attributes;
    for (let i = 0, ii = attributes.length; i < ii; ++i) {
      const attr2 = attributes[i];
      const attrValue = attr2.value;
      const parseResult = parseContent(context, attrValue);
      let result = null;
      if (parseResult === null) {
        if (includeBasicValues) {
          result = new HTMLBindingDirective(() => attrValue);
          result.targetName = attr2.name;
        }
      } else {
        result = createAggregateBinding(parseResult);
      }
      if (result !== null) {
        node.removeAttributeNode(attr2);
        i--;
        ii--;
        context.addFactory(result);
      }
    }
  }
  function compileContent(context, node, walker) {
    const parseResult = parseContent(context, node.textContent);
    if (parseResult !== null) {
      let lastNode = node;
      for (let i = 0, ii = parseResult.length; i < ii; ++i) {
        const currentPart = parseResult[i];
        const currentNode = i === 0 ? node : lastNode.parentNode.insertBefore(document.createTextNode(""), lastNode.nextSibling);
        if (typeof currentPart === "string") {
          currentNode.textContent = currentPart;
        } else {
          currentNode.textContent = " ";
          context.captureContentBinding(currentPart);
        }
        lastNode = currentNode;
        context.targetIndex++;
        if (currentNode !== node) {
          walker.nextNode();
        }
      }
      context.targetIndex--;
    }
  }
  function compileTemplate(template, directives) {
    const fragment = template.content;
    document.adoptNode(fragment);
    const context = CompilationContext.borrow(directives);
    compileAttributes(context, template, true);
    const hostBehaviorFactories = context.behaviorFactories;
    context.reset();
    const walker = DOM.createTemplateWalker(fragment);
    let node;
    while (node = walker.nextNode()) {
      context.targetIndex++;
      switch (node.nodeType) {
        case 1:
          compileAttributes(context, node);
          break;
        case 3:
          compileContent(context, node, walker);
          break;
        case 8:
          if (DOM.isMarker(node)) {
            context.addFactory(directives[DOM.extractDirectiveIndexFromMarker(node)]);
          }
      }
    }
    let targetOffset = 0;
    if (
      // If the first node in a fragment is a marker, that means it's an unstable first node,
      // because something like a when, repeat, etc. could add nodes before the marker.
      // To mitigate this, we insert a stable first node. However, if we insert a node,
      // that will alter the result of the TreeWalker. So, we also need to offset the target index.
      DOM.isMarker(fragment.firstChild) || // Or if there is only one node and a directive, it means the template's content
      // is *only* the directive. In that case, HTMLView.dispose() misses any nodes inserted by
      // the directive. Inserting a new node ensures proper disposal of nodes added by the directive.
      fragment.childNodes.length === 1 && directives.length
    ) {
      fragment.insertBefore(document.createComment(""), fragment.firstChild);
      targetOffset = -1;
    }
    const viewBehaviorFactories = context.behaviorFactories;
    context.release();
    return {
      fragment,
      viewBehaviorFactories,
      hostBehaviorFactories,
      targetOffset
    };
  }
  var sharedContext, CompilationContext, interpolationEndLength;
  var init_compiler = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/templating/compiler.js"() {
      init_dom();
      init_binding();
      sharedContext = null;
      CompilationContext = class _CompilationContext {
        addFactory(factory) {
          factory.targetIndex = this.targetIndex;
          this.behaviorFactories.push(factory);
        }
        captureContentBinding(directive) {
          directive.targetAtContent();
          this.addFactory(directive);
        }
        reset() {
          this.behaviorFactories = [];
          this.targetIndex = -1;
        }
        release() {
          sharedContext = this;
        }
        static borrow(directives) {
          const shareable = sharedContext || new _CompilationContext();
          shareable.directives = directives;
          shareable.reset();
          sharedContext = null;
          return shareable;
        }
      };
      interpolationEndLength = _interpolationEnd.length;
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/templating/view.js
  var range, HTMLView;
  var init_view = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/templating/view.js"() {
      range = document.createRange();
      HTMLView = class {
        /**
         * Constructs an instance of HTMLView.
         * @param fragment - The html fragment that contains the nodes for this view.
         * @param behaviors - The behaviors to be applied to this view.
         */
        constructor(fragment, behaviors) {
          this.fragment = fragment;
          this.behaviors = behaviors;
          this.source = null;
          this.context = null;
          this.firstChild = fragment.firstChild;
          this.lastChild = fragment.lastChild;
        }
        /**
         * Appends the view's DOM nodes to the referenced node.
         * @param node - The parent node to append the view's DOM nodes to.
         */
        appendTo(node) {
          node.appendChild(this.fragment);
        }
        /**
         * Inserts the view's DOM nodes before the referenced node.
         * @param node - The node to insert the view's DOM before.
         */
        insertBefore(node) {
          if (this.fragment.hasChildNodes()) {
            node.parentNode.insertBefore(this.fragment, node);
          } else {
            const end = this.lastChild;
            if (node.previousSibling === end)
              return;
            const parentNode = node.parentNode;
            let current = this.firstChild;
            let next;
            while (current !== end) {
              next = current.nextSibling;
              parentNode.insertBefore(current, node);
              current = next;
            }
            parentNode.insertBefore(end, node);
          }
        }
        /**
         * Removes the view's DOM nodes.
         * The nodes are not disposed and the view can later be re-inserted.
         */
        remove() {
          const fragment = this.fragment;
          const end = this.lastChild;
          let current = this.firstChild;
          let next;
          while (current !== end) {
            next = current.nextSibling;
            fragment.appendChild(current);
            current = next;
          }
          fragment.appendChild(end);
        }
        /**
         * Removes the view and unbinds its behaviors, disposing of DOM nodes afterward.
         * Once a view has been disposed, it cannot be inserted or bound again.
         */
        dispose() {
          const parent = this.firstChild.parentNode;
          const end = this.lastChild;
          let current = this.firstChild;
          let next;
          while (current !== end) {
            next = current.nextSibling;
            parent.removeChild(current);
            current = next;
          }
          parent.removeChild(end);
          const behaviors = this.behaviors;
          const oldSource = this.source;
          for (let i = 0, ii = behaviors.length; i < ii; ++i) {
            behaviors[i].unbind(oldSource);
          }
        }
        /**
         * Binds a view's behaviors to its binding source.
         * @param source - The binding source for the view's binding behaviors.
         * @param context - The execution context to run the behaviors within.
         */
        bind(source, context) {
          const behaviors = this.behaviors;
          if (this.source === source) {
            return;
          } else if (this.source !== null) {
            const oldSource = this.source;
            this.source = source;
            this.context = context;
            for (let i = 0, ii = behaviors.length; i < ii; ++i) {
              const current = behaviors[i];
              current.unbind(oldSource);
              current.bind(source, context);
            }
          } else {
            this.source = source;
            this.context = context;
            for (let i = 0, ii = behaviors.length; i < ii; ++i) {
              behaviors[i].bind(source, context);
            }
          }
        }
        /**
         * Unbinds a view's behaviors from its binding source.
         */
        unbind() {
          if (this.source === null) {
            return;
          }
          const behaviors = this.behaviors;
          const oldSource = this.source;
          for (let i = 0, ii = behaviors.length; i < ii; ++i) {
            behaviors[i].unbind(oldSource);
          }
          this.source = null;
        }
        /**
         * Efficiently disposes of a contiguous range of synthetic view instances.
         * @param views - A contiguous range of views to be disposed.
         */
        static disposeContiguousBatch(views) {
          if (views.length === 0) {
            return;
          }
          range.setStartBefore(views[0].firstChild);
          range.setEndAfter(views[views.length - 1].lastChild);
          range.deleteContents();
          for (let i = 0, ii = views.length; i < ii; ++i) {
            const view = views[i];
            const behaviors = view.behaviors;
            const oldSource = view.source;
            for (let j = 0, jj = behaviors.length; j < jj; ++j) {
              behaviors[j].unbind(oldSource);
            }
          }
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/templating/template.js
  function html(strings, ...values) {
    const directives = [];
    let html2 = "";
    for (let i = 0, ii = strings.length - 1; i < ii; ++i) {
      const currentString = strings[i];
      let value = values[i];
      html2 += currentString;
      if (value instanceof ViewTemplate) {
        const template = value;
        value = () => template;
      }
      if (typeof value === "function") {
        value = new HTMLBindingDirective(value);
      }
      if (value instanceof TargetedHTMLDirective) {
        const match = lastAttributeNameRegex.exec(currentString);
        if (match !== null) {
          value.targetName = match[2];
        }
      }
      if (value instanceof HTMLDirective) {
        html2 += value.createPlaceholder(directives.length);
        directives.push(value);
      } else {
        html2 += value;
      }
    }
    html2 += strings[strings.length - 1];
    return new ViewTemplate(html2, directives);
  }
  var ViewTemplate, lastAttributeNameRegex;
  var init_template = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/templating/template.js"() {
      init_dom();
      init_observable();
      init_compiler();
      init_view();
      init_html_directive();
      init_binding();
      ViewTemplate = class {
        /**
         * Creates an instance of ViewTemplate.
         * @param html - The html representing what this template will instantiate, including placeholders for directives.
         * @param directives - The directives that will be connected to placeholders in the html.
         */
        constructor(html2, directives) {
          this.behaviorCount = 0;
          this.hasHostBehaviors = false;
          this.fragment = null;
          this.targetOffset = 0;
          this.viewBehaviorFactories = null;
          this.hostBehaviorFactories = null;
          this.html = html2;
          this.directives = directives;
        }
        /**
         * Creates an HTMLView instance based on this template definition.
         * @param hostBindingTarget - The element that host behaviors will be bound to.
         */
        create(hostBindingTarget) {
          if (this.fragment === null) {
            let template;
            const html2 = this.html;
            if (typeof html2 === "string") {
              template = document.createElement("template");
              template.innerHTML = DOM.createHTML(html2);
              const fec = template.content.firstElementChild;
              if (fec !== null && fec.tagName === "TEMPLATE") {
                template = fec;
              }
            } else {
              template = html2;
            }
            const result = compileTemplate(template, this.directives);
            this.fragment = result.fragment;
            this.viewBehaviorFactories = result.viewBehaviorFactories;
            this.hostBehaviorFactories = result.hostBehaviorFactories;
            this.targetOffset = result.targetOffset;
            this.behaviorCount = this.viewBehaviorFactories.length + this.hostBehaviorFactories.length;
            this.hasHostBehaviors = this.hostBehaviorFactories.length > 0;
          }
          const fragment = this.fragment.cloneNode(true);
          const viewFactories = this.viewBehaviorFactories;
          const behaviors = new Array(this.behaviorCount);
          const walker = DOM.createTemplateWalker(fragment);
          let behaviorIndex = 0;
          let targetIndex = this.targetOffset;
          let node = walker.nextNode();
          for (let ii = viewFactories.length; behaviorIndex < ii; ++behaviorIndex) {
            const factory = viewFactories[behaviorIndex];
            const factoryIndex = factory.targetIndex;
            while (node !== null) {
              if (targetIndex === factoryIndex) {
                behaviors[behaviorIndex] = factory.createBehavior(node);
                break;
              } else {
                node = walker.nextNode();
                targetIndex++;
              }
            }
          }
          if (this.hasHostBehaviors) {
            const hostFactories = this.hostBehaviorFactories;
            for (let i = 0, ii = hostFactories.length; i < ii; ++i, ++behaviorIndex) {
              behaviors[behaviorIndex] = hostFactories[i].createBehavior(hostBindingTarget);
            }
          }
          return new HTMLView(fragment, behaviors);
        }
        /**
         * Creates an HTMLView from this template, binds it to the source, and then appends it to the host.
         * @param source - The data source to bind the template to.
         * @param host - The Element where the template will be rendered.
         * @param hostBindingTarget - An HTML element to target the host bindings at if different from the
         * host that the template is being attached to.
         */
        render(source, host, hostBindingTarget) {
          if (typeof host === "string") {
            host = document.getElementById(host);
          }
          if (hostBindingTarget === void 0) {
            hostBindingTarget = host;
          }
          const view = this.create(hostBindingTarget);
          view.bind(source, defaultExecutionContext);
          view.appendTo(host);
          return view;
        }
      };
      lastAttributeNameRegex = /* eslint-disable-next-line no-control-regex */
      /([ \x09\x0a\x0c\x0d])([^\0-\x1F\x7F-\x9F "'>=/]+)([ \x09\x0a\x0c\x0d]*=[ \x09\x0a\x0c\x0d]*(?:[^ \x09\x0a\x0c\x0d"'`<>=]*|"[^"]*|'[^']*))$/;
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/styles/element-styles.js
  function reduceStyles(styles) {
    return styles.map((x) => x instanceof ElementStyles ? reduceStyles(x.styles) : [x]).reduce((prev, curr) => prev.concat(curr), []);
  }
  function reduceBehaviors(styles) {
    return styles.map((x) => x instanceof ElementStyles ? x.behaviors : null).reduce((prev, curr) => {
      if (curr === null) {
        return prev;
      }
      if (prev === null) {
        prev = [];
      }
      return prev.concat(curr);
    }, null);
  }
  function separateSheetsToPrepend(sheets) {
    const prepend = [];
    const append = [];
    sheets.forEach((x) => (x[prependToAdoptedStyleSheetsSymbol] ? prepend : append).push(x));
    return { prepend, append };
  }
  function getNextStyleClass() {
    return `fast-style-class-${++styleClassId}`;
  }
  var ElementStyles, prependToAdoptedStyleSheetsSymbol, addAdoptedStyleSheets, removeAdoptedStyleSheets, AdoptedStyleSheetsStyles, styleClassId, StyleElementStyles;
  var init_element_styles = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/styles/element-styles.js"() {
      init_dom();
      ElementStyles = class {
        constructor() {
          this.targets = /* @__PURE__ */ new WeakSet();
        }
        /** @internal */
        addStylesTo(target) {
          this.targets.add(target);
        }
        /** @internal */
        removeStylesFrom(target) {
          this.targets.delete(target);
        }
        /** @internal */
        isAttachedTo(target) {
          return this.targets.has(target);
        }
        /**
         * Associates behaviors with this set of styles.
         * @param behaviors - The behaviors to associate.
         */
        withBehaviors(...behaviors) {
          this.behaviors = this.behaviors === null ? behaviors : this.behaviors.concat(behaviors);
          return this;
        }
      };
      ElementStyles.create = (() => {
        if (DOM.supportsAdoptedStyleSheets) {
          const styleSheetCache = /* @__PURE__ */ new Map();
          return (styles) => (
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            new AdoptedStyleSheetsStyles(styles, styleSheetCache)
          );
        }
        return (styles) => new StyleElementStyles(styles);
      })();
      prependToAdoptedStyleSheetsSymbol = /* @__PURE__ */ Symbol("prependToAdoptedStyleSheets");
      addAdoptedStyleSheets = (target, sheets) => {
        const { prepend, append } = separateSheetsToPrepend(sheets);
        target.adoptedStyleSheets = [...prepend, ...target.adoptedStyleSheets, ...append];
      };
      removeAdoptedStyleSheets = (target, sheets) => {
        target.adoptedStyleSheets = target.adoptedStyleSheets.filter((x) => sheets.indexOf(x) === -1);
      };
      if (DOM.supportsAdoptedStyleSheets) {
        try {
          document.adoptedStyleSheets.push();
          document.adoptedStyleSheets.splice();
          addAdoptedStyleSheets = (target, sheets) => {
            const { prepend, append } = separateSheetsToPrepend(sheets);
            target.adoptedStyleSheets.splice(0, 0, ...prepend);
            target.adoptedStyleSheets.push(...append);
          };
          removeAdoptedStyleSheets = (target, sheets) => {
            for (const sheet of sheets) {
              const index = target.adoptedStyleSheets.indexOf(sheet);
              if (index !== -1) {
                target.adoptedStyleSheets.splice(index, 1);
              }
            }
          };
        } catch (e) {
        }
      }
      AdoptedStyleSheetsStyles = class extends ElementStyles {
        constructor(styles, styleSheetCache) {
          super();
          this.styles = styles;
          this.styleSheetCache = styleSheetCache;
          this._styleSheets = void 0;
          this.behaviors = reduceBehaviors(styles);
        }
        get styleSheets() {
          if (this._styleSheets === void 0) {
            const styles = this.styles;
            const styleSheetCache = this.styleSheetCache;
            this._styleSheets = reduceStyles(styles).map((x) => {
              if (x instanceof CSSStyleSheet) {
                return x;
              }
              let sheet = styleSheetCache.get(x);
              if (sheet === void 0) {
                sheet = new CSSStyleSheet();
                sheet.replaceSync(x);
                styleSheetCache.set(x, sheet);
              }
              return sheet;
            });
          }
          return this._styleSheets;
        }
        addStylesTo(target) {
          addAdoptedStyleSheets(target, this.styleSheets);
          super.addStylesTo(target);
        }
        removeStylesFrom(target) {
          removeAdoptedStyleSheets(target, this.styleSheets);
          super.removeStylesFrom(target);
        }
      };
      styleClassId = 0;
      StyleElementStyles = class extends ElementStyles {
        constructor(styles) {
          super();
          this.styles = styles;
          this.behaviors = null;
          this.behaviors = reduceBehaviors(styles);
          this.styleSheets = reduceStyles(styles);
          this.styleClass = getNextStyleClass();
        }
        addStylesTo(target) {
          const styleSheets = this.styleSheets;
          const styleClass = this.styleClass;
          target = this.normalizeTarget(target);
          for (let i = 0; i < styleSheets.length; i++) {
            const element = document.createElement("style");
            element.innerHTML = styleSheets[i];
            element.className = styleClass;
            target.append(element);
          }
          super.addStylesTo(target);
        }
        removeStylesFrom(target) {
          target = this.normalizeTarget(target);
          const styles = target.querySelectorAll(`.${this.styleClass}`);
          for (let i = 0, ii = styles.length; i < ii; ++i) {
            target.removeChild(styles[i]);
          }
          super.removeStylesFrom(target);
        }
        isAttachedTo(target) {
          return super.isAttachedTo(this.normalizeTarget(target));
        }
        normalizeTarget(target) {
          return target === document ? document.body : target;
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/components/attributes.js
  function attr(configOrTarget, prop) {
    let config;
    function decorator($target, $prop) {
      if (arguments.length > 1) {
        config.property = $prop;
      }
      AttributeConfiguration.locate($target.constructor).push(config);
    }
    if (arguments.length > 1) {
      config = {};
      decorator(configOrTarget, prop);
      return;
    }
    config = configOrTarget === void 0 ? {} : configOrTarget;
    return decorator;
  }
  var AttributeConfiguration, booleanConverter, nullableNumberConverter, AttributeDefinition;
  var init_attributes = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/components/attributes.js"() {
      init_observable();
      init_dom();
      init_platform();
      AttributeConfiguration = Object.freeze({
        /**
         * Locates all attribute configurations associated with a type.
         */
        locate: createMetadataLocator()
      });
      booleanConverter = {
        toView(value) {
          return value ? "true" : "false";
        },
        fromView(value) {
          if (value === null || value === void 0 || value === "false" || value === false || value === 0) {
            return false;
          }
          return true;
        }
      };
      nullableNumberConverter = {
        toView(value) {
          if (value === null || value === void 0) {
            return null;
          }
          const number = value * 1;
          return isNaN(number) ? null : number.toString();
        },
        fromView(value) {
          if (value === null || value === void 0) {
            return null;
          }
          const number = value * 1;
          return isNaN(number) ? null : number;
        }
      };
      AttributeDefinition = class _AttributeDefinition {
        /**
         * Creates an instance of AttributeDefinition.
         * @param Owner - The class constructor that owns this attribute.
         * @param name - The name of the property associated with the attribute.
         * @param attribute - The name of the attribute in HTML.
         * @param mode - The {@link AttributeMode} that describes the behavior of this attribute.
         * @param converter - A {@link ValueConverter} that integrates with the property getter/setter
         * to convert values to and from a DOM string.
         */
        constructor(Owner, name, attribute = name.toLowerCase(), mode = "reflect", converter) {
          this.guards = /* @__PURE__ */ new Set();
          this.Owner = Owner;
          this.name = name;
          this.attribute = attribute;
          this.mode = mode;
          this.converter = converter;
          this.fieldName = `_${name}`;
          this.callbackName = `${name}Changed`;
          this.hasCallback = this.callbackName in Owner.prototype;
          if (mode === "boolean" && converter === void 0) {
            this.converter = booleanConverter;
          }
        }
        /**
         * Sets the value of the attribute/property on the source element.
         * @param source - The source element to access.
         * @param value - The value to set the attribute/property to.
         */
        setValue(source, newValue) {
          const oldValue = source[this.fieldName];
          const converter = this.converter;
          if (converter !== void 0) {
            newValue = converter.fromView(newValue);
          }
          if (oldValue !== newValue) {
            source[this.fieldName] = newValue;
            this.tryReflectToAttribute(source);
            if (this.hasCallback) {
              source[this.callbackName](oldValue, newValue);
            }
            source.$fastController.notify(this.name);
          }
        }
        /**
         * Gets the value of the attribute/property on the source element.
         * @param source - The source element to access.
         */
        getValue(source) {
          Observable.track(source, this.name);
          return source[this.fieldName];
        }
        /** @internal */
        onAttributeChangedCallback(element, value) {
          if (this.guards.has(element)) {
            return;
          }
          this.guards.add(element);
          this.setValue(element, value);
          this.guards.delete(element);
        }
        tryReflectToAttribute(element) {
          const mode = this.mode;
          const guards = this.guards;
          if (guards.has(element) || mode === "fromView") {
            return;
          }
          DOM.queueUpdate(() => {
            guards.add(element);
            const latestValue = element[this.fieldName];
            switch (mode) {
              case "reflect":
                const converter = this.converter;
                DOM.setAttribute(element, this.attribute, converter !== void 0 ? converter.toView(latestValue) : latestValue);
                break;
              case "boolean":
                DOM.setBooleanAttribute(element, this.attribute, latestValue);
                break;
            }
            guards.delete(element);
          });
        }
        /**
         * Collects all attribute definitions associated with the owner.
         * @param Owner - The class constructor to collect attribute for.
         * @param attributeLists - Any existing attributes to collect and merge with those associated with the owner.
         * @internal
         */
        static collect(Owner, ...attributeLists) {
          const attributes = [];
          attributeLists.push(AttributeConfiguration.locate(Owner));
          for (let i = 0, ii = attributeLists.length; i < ii; ++i) {
            const list = attributeLists[i];
            if (list === void 0) {
              continue;
            }
            for (let j = 0, jj = list.length; j < jj; ++j) {
              const config = list[j];
              if (typeof config === "string") {
                attributes.push(new _AttributeDefinition(Owner, config));
              } else {
                attributes.push(new _AttributeDefinition(Owner, config.property, config.attribute, config.mode, config.converter));
              }
            }
          }
          return attributes;
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/components/fast-definitions.js
  var defaultShadowOptions, defaultElementOptions, fastRegistry, FASTElementDefinition;
  var init_fast_definitions = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/components/fast-definitions.js"() {
      init_platform();
      init_observable();
      init_element_styles();
      init_attributes();
      defaultShadowOptions = { mode: "open" };
      defaultElementOptions = {};
      fastRegistry = FAST.getById(4, () => {
        const typeToDefinition = /* @__PURE__ */ new Map();
        return Object.freeze({
          register(definition) {
            if (typeToDefinition.has(definition.type)) {
              return false;
            }
            typeToDefinition.set(definition.type, definition);
            return true;
          },
          getByType(key) {
            return typeToDefinition.get(key);
          }
        });
      });
      FASTElementDefinition = class {
        /**
         * Creates an instance of FASTElementDefinition.
         * @param type - The type this definition is being created for.
         * @param nameOrConfig - The name of the element to define or a config object
         * that describes the element to define.
         */
        constructor(type, nameOrConfig = type.definition) {
          if (typeof nameOrConfig === "string") {
            nameOrConfig = { name: nameOrConfig };
          }
          this.type = type;
          this.name = nameOrConfig.name;
          this.template = nameOrConfig.template;
          const attributes = AttributeDefinition.collect(type, nameOrConfig.attributes);
          const observedAttributes = new Array(attributes.length);
          const propertyLookup = {};
          const attributeLookup = {};
          for (let i = 0, ii = attributes.length; i < ii; ++i) {
            const current = attributes[i];
            observedAttributes[i] = current.attribute;
            propertyLookup[current.name] = current;
            attributeLookup[current.attribute] = current;
          }
          this.attributes = attributes;
          this.observedAttributes = observedAttributes;
          this.propertyLookup = propertyLookup;
          this.attributeLookup = attributeLookup;
          this.shadowOptions = nameOrConfig.shadowOptions === void 0 ? defaultShadowOptions : nameOrConfig.shadowOptions === null ? void 0 : Object.assign(Object.assign({}, defaultShadowOptions), nameOrConfig.shadowOptions);
          this.elementOptions = nameOrConfig.elementOptions === void 0 ? defaultElementOptions : Object.assign(Object.assign({}, defaultElementOptions), nameOrConfig.elementOptions);
          this.styles = nameOrConfig.styles === void 0 ? void 0 : Array.isArray(nameOrConfig.styles) ? ElementStyles.create(nameOrConfig.styles) : nameOrConfig.styles instanceof ElementStyles ? nameOrConfig.styles : ElementStyles.create([nameOrConfig.styles]);
        }
        /**
         * Indicates if this element has been defined in at least one registry.
         */
        get isDefined() {
          return !!fastRegistry.getByType(this.type);
        }
        /**
         * Defines a custom element based on this definition.
         * @param registry - The element registry to define the element in.
         */
        define(registry = customElements) {
          const type = this.type;
          if (fastRegistry.register(this)) {
            const attributes = this.attributes;
            const proto = type.prototype;
            for (let i = 0, ii = attributes.length; i < ii; ++i) {
              Observable.defineProperty(proto, attributes[i]);
            }
            Reflect.defineProperty(type, "observedAttributes", {
              value: this.observedAttributes,
              enumerable: true
            });
          }
          if (!registry.get(this.name)) {
            registry.define(this.name, type, this.elementOptions);
          }
          return this;
        }
      };
      FASTElementDefinition.forType = fastRegistry.getByType;
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/components/controller.js
  function getShadowRoot(element) {
    return element.shadowRoot || shadowRoots.get(element) || null;
  }
  var shadowRoots, defaultEventOptions, Controller;
  var init_controller = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/components/controller.js"() {
      init_dom();
      init_notifier();
      init_observable();
      init_fast_definitions();
      shadowRoots = /* @__PURE__ */ new WeakMap();
      defaultEventOptions = {
        bubbles: true,
        composed: true,
        cancelable: true
      };
      Controller = class _Controller extends PropertyChangeNotifier {
        /**
         * Creates a Controller to control the specified element.
         * @param element - The element to be controlled by this controller.
         * @param definition - The element definition metadata that instructs this
         * controller in how to handle rendering and other platform integrations.
         * @internal
         */
        constructor(element, definition) {
          super(element);
          this.boundObservables = null;
          this.behaviors = null;
          this.needsInitialization = true;
          this._template = null;
          this._styles = null;
          this._isConnected = false;
          this.$fastController = this;
          this.view = null;
          this.element = element;
          this.definition = definition;
          const shadowOptions = definition.shadowOptions;
          if (shadowOptions !== void 0) {
            const shadowRoot = element.attachShadow(shadowOptions);
            if (shadowOptions.mode === "closed") {
              shadowRoots.set(element, shadowRoot);
            }
          }
          const accessors = Observable.getAccessors(element);
          if (accessors.length > 0) {
            const boundObservables = this.boundObservables = /* @__PURE__ */ Object.create(null);
            for (let i = 0, ii = accessors.length; i < ii; ++i) {
              const propertyName = accessors[i].name;
              const value = element[propertyName];
              if (value !== void 0) {
                delete element[propertyName];
                boundObservables[propertyName] = value;
              }
            }
          }
        }
        /**
         * Indicates whether or not the custom element has been
         * connected to the document.
         */
        get isConnected() {
          Observable.track(this, "isConnected");
          return this._isConnected;
        }
        setIsConnected(value) {
          this._isConnected = value;
          Observable.notify(this, "isConnected");
        }
        /**
         * Gets/sets the template used to render the component.
         * @remarks
         * This value can only be accurately read after connect but can be set at any time.
         */
        get template() {
          return this._template;
        }
        set template(value) {
          if (this._template === value) {
            return;
          }
          this._template = value;
          if (!this.needsInitialization) {
            this.renderTemplate(value);
          }
        }
        /**
         * Gets/sets the primary styles used for the component.
         * @remarks
         * This value can only be accurately read after connect but can be set at any time.
         */
        get styles() {
          return this._styles;
        }
        set styles(value) {
          if (this._styles === value) {
            return;
          }
          if (this._styles !== null) {
            this.removeStyles(this._styles);
          }
          this._styles = value;
          if (!this.needsInitialization && value !== null) {
            this.addStyles(value);
          }
        }
        /**
         * Adds styles to this element. Providing an HTMLStyleElement will attach the element instance to the shadowRoot.
         * @param styles - The styles to add.
         */
        addStyles(styles) {
          const target = getShadowRoot(this.element) || this.element.getRootNode();
          if (styles instanceof HTMLStyleElement) {
            target.append(styles);
          } else if (!styles.isAttachedTo(target)) {
            const sourceBehaviors = styles.behaviors;
            styles.addStylesTo(target);
            if (sourceBehaviors !== null) {
              this.addBehaviors(sourceBehaviors);
            }
          }
        }
        /**
         * Removes styles from this element. Providing an HTMLStyleElement will detach the element instance from the shadowRoot.
         * @param styles - the styles to remove.
         */
        removeStyles(styles) {
          const target = getShadowRoot(this.element) || this.element.getRootNode();
          if (styles instanceof HTMLStyleElement) {
            target.removeChild(styles);
          } else if (styles.isAttachedTo(target)) {
            const sourceBehaviors = styles.behaviors;
            styles.removeStylesFrom(target);
            if (sourceBehaviors !== null) {
              this.removeBehaviors(sourceBehaviors);
            }
          }
        }
        /**
         * Adds behaviors to this element.
         * @param behaviors - The behaviors to add.
         */
        addBehaviors(behaviors) {
          const targetBehaviors = this.behaviors || (this.behaviors = /* @__PURE__ */ new Map());
          const length = behaviors.length;
          const behaviorsToBind = [];
          for (let i = 0; i < length; ++i) {
            const behavior = behaviors[i];
            if (targetBehaviors.has(behavior)) {
              targetBehaviors.set(behavior, targetBehaviors.get(behavior) + 1);
            } else {
              targetBehaviors.set(behavior, 1);
              behaviorsToBind.push(behavior);
            }
          }
          if (this._isConnected) {
            const element = this.element;
            for (let i = 0; i < behaviorsToBind.length; ++i) {
              behaviorsToBind[i].bind(element, defaultExecutionContext);
            }
          }
        }
        /**
         * Removes behaviors from this element.
         * @param behaviors - The behaviors to remove.
         * @param force - Forces unbinding of behaviors.
         */
        removeBehaviors(behaviors, force = false) {
          const targetBehaviors = this.behaviors;
          if (targetBehaviors === null) {
            return;
          }
          const length = behaviors.length;
          const behaviorsToUnbind = [];
          for (let i = 0; i < length; ++i) {
            const behavior = behaviors[i];
            if (targetBehaviors.has(behavior)) {
              const count = targetBehaviors.get(behavior) - 1;
              count === 0 || force ? targetBehaviors.delete(behavior) && behaviorsToUnbind.push(behavior) : targetBehaviors.set(behavior, count);
            }
          }
          if (this._isConnected) {
            const element = this.element;
            for (let i = 0; i < behaviorsToUnbind.length; ++i) {
              behaviorsToUnbind[i].unbind(element);
            }
          }
        }
        /**
         * Runs connected lifecycle behavior on the associated element.
         */
        onConnectedCallback() {
          if (this._isConnected) {
            return;
          }
          const element = this.element;
          if (this.needsInitialization) {
            this.finishInitialization();
          } else if (this.view !== null) {
            this.view.bind(element, defaultExecutionContext);
          }
          const behaviors = this.behaviors;
          if (behaviors !== null) {
            for (const [behavior] of behaviors) {
              behavior.bind(element, defaultExecutionContext);
            }
          }
          this.setIsConnected(true);
        }
        /**
         * Runs disconnected lifecycle behavior on the associated element.
         */
        onDisconnectedCallback() {
          if (!this._isConnected) {
            return;
          }
          this.setIsConnected(false);
          const view = this.view;
          if (view !== null) {
            view.unbind();
          }
          const behaviors = this.behaviors;
          if (behaviors !== null) {
            const element = this.element;
            for (const [behavior] of behaviors) {
              behavior.unbind(element);
            }
          }
        }
        /**
         * Runs the attribute changed callback for the associated element.
         * @param name - The name of the attribute that changed.
         * @param oldValue - The previous value of the attribute.
         * @param newValue - The new value of the attribute.
         */
        onAttributeChangedCallback(name, oldValue, newValue) {
          const attrDef = this.definition.attributeLookup[name];
          if (attrDef !== void 0) {
            attrDef.onAttributeChangedCallback(this.element, newValue);
          }
        }
        /**
         * Emits a custom HTML event.
         * @param type - The type name of the event.
         * @param detail - The event detail object to send with the event.
         * @param options - The event options. By default bubbles and composed.
         * @remarks
         * Only emits events if connected.
         */
        emit(type, detail, options) {
          if (this._isConnected) {
            return this.element.dispatchEvent(new CustomEvent(type, Object.assign(Object.assign({ detail }, defaultEventOptions), options)));
          }
          return false;
        }
        finishInitialization() {
          const element = this.element;
          const boundObservables = this.boundObservables;
          if (boundObservables !== null) {
            const propertyNames = Object.keys(boundObservables);
            for (let i = 0, ii = propertyNames.length; i < ii; ++i) {
              const propertyName = propertyNames[i];
              element[propertyName] = boundObservables[propertyName];
            }
            this.boundObservables = null;
          }
          const definition = this.definition;
          if (this._template === null) {
            if (this.element.resolveTemplate) {
              this._template = this.element.resolveTemplate();
            } else if (definition.template) {
              this._template = definition.template || null;
            }
          }
          if (this._template !== null) {
            this.renderTemplate(this._template);
          }
          if (this._styles === null) {
            if (this.element.resolveStyles) {
              this._styles = this.element.resolveStyles();
            } else if (definition.styles) {
              this._styles = definition.styles || null;
            }
          }
          if (this._styles !== null) {
            this.addStyles(this._styles);
          }
          this.needsInitialization = false;
        }
        renderTemplate(template) {
          const element = this.element;
          const host = getShadowRoot(element) || element;
          if (this.view !== null) {
            this.view.dispose();
            this.view = null;
          } else if (!this.needsInitialization) {
            DOM.removeChildNodes(host);
          }
          if (template) {
            this.view = template.render(element, host, element);
          }
        }
        /**
         * Locates or creates a controller for the specified element.
         * @param element - The element to return the controller for.
         * @remarks
         * The specified element must have a {@link FASTElementDefinition}
         * registered either through the use of the {@link customElement}
         * decorator or a call to `FASTElement.define`.
         */
        static forCustomElement(element) {
          const controller = element.$fastController;
          if (controller !== void 0) {
            return controller;
          }
          const definition = FASTElementDefinition.forType(element.constructor);
          if (definition === void 0) {
            throw new Error("Missing FASTElement definition.");
          }
          return element.$fastController = new _Controller(element, definition);
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/components/fast-element.js
  function createFASTElement(BaseType) {
    return class extends BaseType {
      constructor() {
        super();
        Controller.forCustomElement(this);
      }
      $emit(type, detail, options) {
        return this.$fastController.emit(type, detail, options);
      }
      connectedCallback() {
        this.$fastController.onConnectedCallback();
      }
      disconnectedCallback() {
        this.$fastController.onDisconnectedCallback();
      }
      attributeChangedCallback(name, oldValue, newValue) {
        this.$fastController.onAttributeChangedCallback(name, oldValue, newValue);
      }
    };
  }
  var FASTElement;
  var init_fast_element = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/components/fast-element.js"() {
      init_controller();
      init_fast_definitions();
      FASTElement = Object.assign(createFASTElement(HTMLElement), {
        /**
         * Creates a new FASTElement base class inherited from the
         * provided base type.
         * @param BaseType - The base element type to inherit from.
         */
        from(BaseType) {
          return createFASTElement(BaseType);
        },
        /**
         * Defines a platform custom element based on the provided type and definition.
         * @param type - The custom element type to define.
         * @param nameOrDef - The name of the element to define or a definition object
         * that describes the element to define.
         */
        define(type, nameOrDef) {
          return new FASTElementDefinition(type, nameOrDef).define().type;
        }
      });
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/styles/css-directive.js
  var CSSDirective;
  var init_css_directive = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/styles/css-directive.js"() {
      CSSDirective = class {
        /**
         * Creates a CSS fragment to interpolate into the CSS document.
         * @returns - the string to interpolate into CSS
         */
        createCSS() {
          return "";
        }
        /**
         * Creates a behavior to bind to the host element.
         * @returns - the behavior to bind to the host element, or undefined.
         */
        createBehavior() {
          return void 0;
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/styles/css.js
  function collectStyles(strings, values) {
    const styles = [];
    let cssString = "";
    const behaviors = [];
    for (let i = 0, ii = strings.length - 1; i < ii; ++i) {
      cssString += strings[i];
      let value = values[i];
      if (value instanceof CSSDirective) {
        const behavior = value.createBehavior();
        value = value.createCSS();
        if (behavior) {
          behaviors.push(behavior);
        }
      }
      if (value instanceof ElementStyles || value instanceof CSSStyleSheet) {
        if (cssString.trim() !== "") {
          styles.push(cssString);
          cssString = "";
        }
        styles.push(value);
      } else {
        cssString += value;
      }
    }
    cssString += strings[strings.length - 1];
    if (cssString.trim() !== "") {
      styles.push(cssString);
    }
    return {
      styles,
      behaviors
    };
  }
  function css(strings, ...values) {
    const { styles, behaviors } = collectStyles(strings, values);
    const elementStyles = ElementStyles.create(styles);
    if (behaviors.length) {
      elementStyles.withBehaviors(...behaviors);
    }
    return elementStyles;
  }
  var init_css = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/styles/css.js"() {
      init_css_directive();
      init_element_styles();
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/observation/array-change-records.js
  function newSplice(index, removed, addedCount) {
    return {
      index,
      removed,
      addedCount
    };
  }
  function calcEditDistances(current, currentStart, currentEnd, old, oldStart, oldEnd) {
    const rowCount = oldEnd - oldStart + 1;
    const columnCount = currentEnd - currentStart + 1;
    const distances = new Array(rowCount);
    let north;
    let west;
    for (let i = 0; i < rowCount; ++i) {
      distances[i] = new Array(columnCount);
      distances[i][0] = i;
    }
    for (let j = 0; j < columnCount; ++j) {
      distances[0][j] = j;
    }
    for (let i = 1; i < rowCount; ++i) {
      for (let j = 1; j < columnCount; ++j) {
        if (current[currentStart + j - 1] === old[oldStart + i - 1]) {
          distances[i][j] = distances[i - 1][j - 1];
        } else {
          north = distances[i - 1][j] + 1;
          west = distances[i][j - 1] + 1;
          distances[i][j] = north < west ? north : west;
        }
      }
    }
    return distances;
  }
  function spliceOperationsFromEditDistances(distances) {
    let i = distances.length - 1;
    let j = distances[0].length - 1;
    let current = distances[i][j];
    const edits = [];
    while (i > 0 || j > 0) {
      if (i === 0) {
        edits.push(EDIT_ADD);
        j--;
        continue;
      }
      if (j === 0) {
        edits.push(EDIT_DELETE);
        i--;
        continue;
      }
      const northWest = distances[i - 1][j - 1];
      const west = distances[i - 1][j];
      const north = distances[i][j - 1];
      let min;
      if (west < north) {
        min = west < northWest ? west : northWest;
      } else {
        min = north < northWest ? north : northWest;
      }
      if (min === northWest) {
        if (northWest === current) {
          edits.push(EDIT_LEAVE);
        } else {
          edits.push(EDIT_UPDATE);
          current = northWest;
        }
        i--;
        j--;
      } else if (min === west) {
        edits.push(EDIT_DELETE);
        i--;
        current = west;
      } else {
        edits.push(EDIT_ADD);
        j--;
        current = north;
      }
    }
    edits.reverse();
    return edits;
  }
  function sharedPrefix(current, old, searchLength) {
    for (let i = 0; i < searchLength; ++i) {
      if (current[i] !== old[i]) {
        return i;
      }
    }
    return searchLength;
  }
  function sharedSuffix(current, old, searchLength) {
    let index1 = current.length;
    let index2 = old.length;
    let count = 0;
    while (count < searchLength && current[--index1] === old[--index2]) {
      count++;
    }
    return count;
  }
  function intersect(start1, end1, start2, end2) {
    if (end1 < start2 || end2 < start1) {
      return -1;
    }
    if (end1 === start2 || end2 === start1) {
      return 0;
    }
    if (start1 < start2) {
      if (end1 < end2) {
        return end1 - start2;
      }
      return end2 - start2;
    }
    if (end2 < end1) {
      return end2 - start1;
    }
    return end1 - start1;
  }
  function calcSplices(current, currentStart, currentEnd, old, oldStart, oldEnd) {
    let prefixCount = 0;
    let suffixCount = 0;
    const minLength = Math.min(currentEnd - currentStart, oldEnd - oldStart);
    if (currentStart === 0 && oldStart === 0) {
      prefixCount = sharedPrefix(current, old, minLength);
    }
    if (currentEnd === current.length && oldEnd === old.length) {
      suffixCount = sharedSuffix(current, old, minLength - prefixCount);
    }
    currentStart += prefixCount;
    oldStart += prefixCount;
    currentEnd -= suffixCount;
    oldEnd -= suffixCount;
    if (currentEnd - currentStart === 0 && oldEnd - oldStart === 0) {
      return emptyArray;
    }
    if (currentStart === currentEnd) {
      const splice2 = newSplice(currentStart, [], 0);
      while (oldStart < oldEnd) {
        splice2.removed.push(old[oldStart++]);
      }
      return [splice2];
    } else if (oldStart === oldEnd) {
      return [newSplice(currentStart, [], currentEnd - currentStart)];
    }
    const ops = spliceOperationsFromEditDistances(calcEditDistances(current, currentStart, currentEnd, old, oldStart, oldEnd));
    const splices = [];
    let splice = void 0;
    let index = currentStart;
    let oldIndex = oldStart;
    for (let i = 0; i < ops.length; ++i) {
      switch (ops[i]) {
        case EDIT_LEAVE:
          if (splice !== void 0) {
            splices.push(splice);
            splice = void 0;
          }
          index++;
          oldIndex++;
          break;
        case EDIT_UPDATE:
          if (splice === void 0) {
            splice = newSplice(index, [], 0);
          }
          splice.addedCount++;
          index++;
          splice.removed.push(old[oldIndex]);
          oldIndex++;
          break;
        case EDIT_ADD:
          if (splice === void 0) {
            splice = newSplice(index, [], 0);
          }
          splice.addedCount++;
          index++;
          break;
        case EDIT_DELETE:
          if (splice === void 0) {
            splice = newSplice(index, [], 0);
          }
          splice.removed.push(old[oldIndex]);
          oldIndex++;
          break;
      }
    }
    if (splice !== void 0) {
      splices.push(splice);
    }
    return splices;
  }
  function mergeSplice(splices, index, removed, addedCount) {
    const splice = newSplice(index, removed, addedCount);
    let inserted = false;
    let insertionOffset = 0;
    for (let i = 0; i < splices.length; i++) {
      const current = splices[i];
      current.index += insertionOffset;
      if (inserted) {
        continue;
      }
      const intersectCount = intersect(splice.index, splice.index + splice.removed.length, current.index, current.index + current.addedCount);
      if (intersectCount >= 0) {
        splices.splice(i, 1);
        i--;
        insertionOffset -= current.addedCount - current.removed.length;
        splice.addedCount += current.addedCount - intersectCount;
        const deleteCount = splice.removed.length + current.removed.length - intersectCount;
        if (!splice.addedCount && !deleteCount) {
          inserted = true;
        } else {
          let currentRemoved = current.removed;
          if (splice.index < current.index) {
            const prepend = splice.removed.slice(0, current.index - splice.index);
            $push.apply(prepend, currentRemoved);
            currentRemoved = prepend;
          }
          if (splice.index + splice.removed.length > current.index + current.addedCount) {
            const append = splice.removed.slice(current.index + current.addedCount - splice.index);
            $push.apply(currentRemoved, append);
          }
          splice.removed = currentRemoved;
          if (current.index < splice.index) {
            splice.index = current.index;
          }
        }
      } else if (splice.index < current.index) {
        inserted = true;
        splices.splice(i, 0, splice);
        i++;
        const offset = splice.addedCount - splice.removed.length;
        current.index += offset;
        insertionOffset += offset;
      }
    }
    if (!inserted) {
      splices.push(splice);
    }
  }
  function createInitialSplices(changeRecords) {
    const splices = [];
    for (let i = 0, ii = changeRecords.length; i < ii; i++) {
      const record = changeRecords[i];
      mergeSplice(splices, record.index, record.removed, record.addedCount);
    }
    return splices;
  }
  function projectArraySplices(array, changeRecords) {
    let splices = [];
    const initialSplices = createInitialSplices(changeRecords);
    for (let i = 0, ii = initialSplices.length; i < ii; ++i) {
      const splice = initialSplices[i];
      if (splice.addedCount === 1 && splice.removed.length === 1) {
        if (splice.removed[0] !== array[splice.index]) {
          splices.push(splice);
        }
        continue;
      }
      splices = splices.concat(calcSplices(array, splice.index, splice.index + splice.addedCount, splice.removed, 0, splice.removed.length));
    }
    return splices;
  }
  var EDIT_LEAVE, EDIT_UPDATE, EDIT_ADD, EDIT_DELETE, $push;
  var init_array_change_records = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/observation/array-change-records.js"() {
      init_platform();
      EDIT_LEAVE = 0;
      EDIT_UPDATE = 1;
      EDIT_ADD = 2;
      EDIT_DELETE = 3;
      $push = Array.prototype.push;
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/observation/array-observer.js
  function adjustIndex(changeRecord, array) {
    let index = changeRecord.index;
    const arrayLength = array.length;
    if (index > arrayLength) {
      index = arrayLength - changeRecord.addedCount;
    } else if (index < 0) {
      index = arrayLength + changeRecord.removed.length + index - changeRecord.addedCount;
    }
    if (index < 0) {
      index = 0;
    }
    changeRecord.index = index;
    return changeRecord;
  }
  function enableArrayObservation() {
    if (arrayObservationEnabled) {
      return;
    }
    arrayObservationEnabled = true;
    Observable.setArrayObserverFactory((collection) => {
      return new ArrayObserver(collection);
    });
    const proto = Array.prototype;
    if (proto.$fastPatch) {
      return;
    }
    Reflect.defineProperty(proto, "$fastPatch", {
      value: 1,
      enumerable: false
    });
    const pop = proto.pop;
    const push = proto.push;
    const reverse = proto.reverse;
    const shift = proto.shift;
    const sort = proto.sort;
    const splice = proto.splice;
    const unshift = proto.unshift;
    proto.pop = function() {
      const notEmpty = this.length > 0;
      const methodCallResult = pop.apply(this, arguments);
      const o = this.$fastController;
      if (o !== void 0 && notEmpty) {
        o.addSplice(newSplice(this.length, [methodCallResult], 0));
      }
      return methodCallResult;
    };
    proto.push = function() {
      const methodCallResult = push.apply(this, arguments);
      const o = this.$fastController;
      if (o !== void 0) {
        o.addSplice(adjustIndex(newSplice(this.length - arguments.length, [], arguments.length), this));
      }
      return methodCallResult;
    };
    proto.reverse = function() {
      let oldArray;
      const o = this.$fastController;
      if (o !== void 0) {
        o.flush();
        oldArray = this.slice();
      }
      const methodCallResult = reverse.apply(this, arguments);
      if (o !== void 0) {
        o.reset(oldArray);
      }
      return methodCallResult;
    };
    proto.shift = function() {
      const notEmpty = this.length > 0;
      const methodCallResult = shift.apply(this, arguments);
      const o = this.$fastController;
      if (o !== void 0 && notEmpty) {
        o.addSplice(newSplice(0, [methodCallResult], 0));
      }
      return methodCallResult;
    };
    proto.sort = function() {
      let oldArray;
      const o = this.$fastController;
      if (o !== void 0) {
        o.flush();
        oldArray = this.slice();
      }
      const methodCallResult = sort.apply(this, arguments);
      if (o !== void 0) {
        o.reset(oldArray);
      }
      return methodCallResult;
    };
    proto.splice = function() {
      const methodCallResult = splice.apply(this, arguments);
      const o = this.$fastController;
      if (o !== void 0) {
        o.addSplice(adjustIndex(newSplice(+arguments[0], methodCallResult, arguments.length > 2 ? arguments.length - 2 : 0), this));
      }
      return methodCallResult;
    };
    proto.unshift = function() {
      const methodCallResult = unshift.apply(this, arguments);
      const o = this.$fastController;
      if (o !== void 0) {
        o.addSplice(adjustIndex(newSplice(0, [], arguments.length), this));
      }
      return methodCallResult;
    };
  }
  var arrayObservationEnabled, ArrayObserver;
  var init_array_observer = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/observation/array-observer.js"() {
      init_dom();
      init_array_change_records();
      init_notifier();
      init_observable();
      arrayObservationEnabled = false;
      ArrayObserver = class extends SubscriberSet {
        constructor(source) {
          super(source);
          this.oldCollection = void 0;
          this.splices = void 0;
          this.needsQueue = true;
          this.call = this.flush;
          Reflect.defineProperty(source, "$fastController", {
            value: this,
            enumerable: false
          });
        }
        subscribe(subscriber) {
          this.flush();
          super.subscribe(subscriber);
        }
        addSplice(splice) {
          if (this.splices === void 0) {
            this.splices = [splice];
          } else {
            this.splices.push(splice);
          }
          if (this.needsQueue) {
            this.needsQueue = false;
            DOM.queueUpdate(this);
          }
        }
        reset(oldCollection) {
          this.oldCollection = oldCollection;
          if (this.needsQueue) {
            this.needsQueue = false;
            DOM.queueUpdate(this);
          }
        }
        flush() {
          const splices = this.splices;
          const oldCollection = this.oldCollection;
          if (splices === void 0 && oldCollection === void 0) {
            return;
          }
          this.needsQueue = true;
          this.splices = void 0;
          this.oldCollection = void 0;
          const finalSplices = oldCollection === void 0 ? projectArraySplices(this.source, splices) : calcSplices(this.source, 0, this.source.length, oldCollection, 0, oldCollection.length);
          this.notify(finalSplices);
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/templating/ref.js
  function ref(propertyName) {
    return new AttachedBehaviorHTMLDirective("fast-ref", RefBehavior, propertyName);
  }
  var RefBehavior;
  var init_ref = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/templating/ref.js"() {
      init_html_directive();
      RefBehavior = class {
        /**
         * Creates an instance of RefBehavior.
         * @param target - The element to reference.
         * @param propertyName - The name of the property to assign the reference to.
         */
        constructor(target, propertyName) {
          this.target = target;
          this.propertyName = propertyName;
        }
        /**
         * Bind this behavior to the source.
         * @param source - The source to bind to.
         * @param context - The execution context that the binding is operating within.
         */
        bind(source) {
          source[this.propertyName] = this.target;
        }
        /**
         * Unbinds this behavior from the source.
         * @param source - The source to unbind from.
         */
        /* eslint-disable-next-line @typescript-eslint/no-empty-function */
        unbind() {
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/interfaces.js
  var isFunction;
  var init_interfaces = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/interfaces.js"() {
      isFunction = (object) => typeof object === "function";
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/templating/when.js
  function normalizeBinding(value) {
    return value === void 0 ? noTemplate : isFunction(value) ? value : () => value;
  }
  function when(binding, templateOrTemplateBinding, elseTemplateOrTemplateBinding) {
    const dataBinding = isFunction(binding) ? binding : () => binding;
    const templateBinding = normalizeBinding(templateOrTemplateBinding);
    const elseBinding = normalizeBinding(elseTemplateOrTemplateBinding);
    return (source, context) => dataBinding(source, context) ? templateBinding(source, context) : elseBinding(source, context);
  }
  var noTemplate;
  var init_when = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/templating/when.js"() {
      init_interfaces();
      noTemplate = () => null;
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/templating/repeat.js
  function bindWithoutPositioning(view, items, index, context) {
    view.bind(items[index], context);
  }
  function bindWithPositioning(view, items, index, context) {
    const childContext = Object.create(context);
    childContext.index = index;
    childContext.length = items.length;
    view.bind(items[index], childContext);
  }
  var defaultRepeatOptions, RepeatBehavior, RepeatDirective;
  var init_repeat = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/templating/repeat.js"() {
      init_dom();
      init_observable();
      init_array_observer();
      init_platform();
      init_html_directive();
      init_view();
      defaultRepeatOptions = Object.freeze({
        positioning: false,
        recycle: true
      });
      RepeatBehavior = class {
        /**
         * Creates an instance of RepeatBehavior.
         * @param location - The location in the DOM to render the repeat.
         * @param itemsBinding - The array to render.
         * @param isItemsBindingVolatile - Indicates whether the items binding has volatile dependencies.
         * @param templateBinding - The template to render for each item.
         * @param isTemplateBindingVolatile - Indicates whether the template binding has volatile dependencies.
         * @param options - Options used to turn on special repeat features.
         */
        constructor(location, itemsBinding, isItemsBindingVolatile, templateBinding, isTemplateBindingVolatile, options) {
          this.location = location;
          this.itemsBinding = itemsBinding;
          this.templateBinding = templateBinding;
          this.options = options;
          this.source = null;
          this.views = [];
          this.items = null;
          this.itemsObserver = null;
          this.originalContext = void 0;
          this.childContext = void 0;
          this.bindView = bindWithoutPositioning;
          this.itemsBindingObserver = Observable.binding(itemsBinding, this, isItemsBindingVolatile);
          this.templateBindingObserver = Observable.binding(templateBinding, this, isTemplateBindingVolatile);
          if (options.positioning) {
            this.bindView = bindWithPositioning;
          }
        }
        /**
         * Bind this behavior to the source.
         * @param source - The source to bind to.
         * @param context - The execution context that the binding is operating within.
         */
        bind(source, context) {
          this.source = source;
          this.originalContext = context;
          this.childContext = Object.create(context);
          this.childContext.parent = source;
          this.childContext.parentContext = this.originalContext;
          this.items = this.itemsBindingObserver.observe(source, this.originalContext);
          this.template = this.templateBindingObserver.observe(source, this.originalContext);
          this.observeItems(true);
          this.refreshAllViews();
        }
        /**
         * Unbinds this behavior from the source.
         * @param source - The source to unbind from.
         */
        unbind() {
          this.source = null;
          this.items = null;
          if (this.itemsObserver !== null) {
            this.itemsObserver.unsubscribe(this);
          }
          this.unbindAllViews();
          this.itemsBindingObserver.disconnect();
          this.templateBindingObserver.disconnect();
        }
        /** @internal */
        handleChange(source, args) {
          if (source === this.itemsBinding) {
            this.items = this.itemsBindingObserver.observe(this.source, this.originalContext);
            this.observeItems();
            this.refreshAllViews();
          } else if (source === this.templateBinding) {
            this.template = this.templateBindingObserver.observe(this.source, this.originalContext);
            this.refreshAllViews(true);
          } else {
            this.updateViews(args);
          }
        }
        observeItems(force = false) {
          if (!this.items) {
            this.items = emptyArray;
            return;
          }
          const oldObserver = this.itemsObserver;
          const newObserver = this.itemsObserver = Observable.getNotifier(this.items);
          const hasNewObserver = oldObserver !== newObserver;
          if (hasNewObserver && oldObserver !== null) {
            oldObserver.unsubscribe(this);
          }
          if (hasNewObserver || force) {
            newObserver.subscribe(this);
          }
        }
        updateViews(splices) {
          const childContext = this.childContext;
          const views = this.views;
          const bindView = this.bindView;
          const items = this.items;
          const template = this.template;
          const recycle = this.options.recycle;
          const leftoverViews = [];
          let leftoverIndex = 0;
          let availableViews = 0;
          for (let i = 0, ii = splices.length; i < ii; ++i) {
            const splice = splices[i];
            const removed = splice.removed;
            let removeIndex = 0;
            let addIndex = splice.index;
            const end = addIndex + splice.addedCount;
            const removedViews = views.splice(splice.index, removed.length);
            const totalAvailableViews = availableViews = leftoverViews.length + removedViews.length;
            for (; addIndex < end; ++addIndex) {
              const neighbor = views[addIndex];
              const location = neighbor ? neighbor.firstChild : this.location;
              let view;
              if (recycle && availableViews > 0) {
                if (removeIndex <= totalAvailableViews && removedViews.length > 0) {
                  view = removedViews[removeIndex];
                  removeIndex++;
                } else {
                  view = leftoverViews[leftoverIndex];
                  leftoverIndex++;
                }
                availableViews--;
              } else {
                view = template.create();
              }
              views.splice(addIndex, 0, view);
              bindView(view, items, addIndex, childContext);
              view.insertBefore(location);
            }
            if (removedViews[removeIndex]) {
              leftoverViews.push(...removedViews.slice(removeIndex));
            }
          }
          for (let i = leftoverIndex, ii = leftoverViews.length; i < ii; ++i) {
            leftoverViews[i].dispose();
          }
          if (this.options.positioning) {
            for (let i = 0, ii = views.length; i < ii; ++i) {
              const currentContext = views[i].context;
              currentContext.length = ii;
              currentContext.index = i;
            }
          }
        }
        refreshAllViews(templateChanged = false) {
          const items = this.items;
          const childContext = this.childContext;
          const template = this.template;
          const location = this.location;
          const bindView = this.bindView;
          let itemsLength = items.length;
          let views = this.views;
          let viewsLength = views.length;
          if (itemsLength === 0 || templateChanged || !this.options.recycle) {
            HTMLView.disposeContiguousBatch(views);
            viewsLength = 0;
          }
          if (viewsLength === 0) {
            this.views = views = new Array(itemsLength);
            for (let i = 0; i < itemsLength; ++i) {
              const view = template.create();
              bindView(view, items, i, childContext);
              views[i] = view;
              view.insertBefore(location);
            }
          } else {
            let i = 0;
            for (; i < itemsLength; ++i) {
              if (i < viewsLength) {
                const view = views[i];
                bindView(view, items, i, childContext);
              } else {
                const view = template.create();
                bindView(view, items, i, childContext);
                views.push(view);
                view.insertBefore(location);
              }
            }
            const removed = views.splice(i, viewsLength - i);
            for (i = 0, itemsLength = removed.length; i < itemsLength; ++i) {
              removed[i].dispose();
            }
          }
        }
        unbindAllViews() {
          const views = this.views;
          for (let i = 0, ii = views.length; i < ii; ++i) {
            views[i].unbind();
          }
        }
      };
      RepeatDirective = class extends HTMLDirective {
        /**
         * Creates an instance of RepeatDirective.
         * @param itemsBinding - The binding that provides the array to render.
         * @param templateBinding - The template binding used to obtain a template to render for each item in the array.
         * @param options - Options used to turn on special repeat features.
         */
        constructor(itemsBinding, templateBinding, options) {
          super();
          this.itemsBinding = itemsBinding;
          this.templateBinding = templateBinding;
          this.options = options;
          this.createPlaceholder = DOM.createBlockPlaceholder;
          enableArrayObservation();
          this.isItemsBindingVolatile = Observable.isVolatileBinding(itemsBinding);
          this.isTemplateBindingVolatile = Observable.isVolatileBinding(templateBinding);
        }
        /**
         * Creates a behavior for the provided target node.
         * @param target - The node instance to create the behavior for.
         */
        createBehavior(target) {
          return new RepeatBehavior(target, this.itemsBinding, this.isItemsBindingVolatile, this.templateBinding, this.isTemplateBindingVolatile, this.options);
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/templating/node-observation.js
  function elements(selector) {
    if (selector) {
      return function(value, index, array) {
        return value.nodeType === 1 && value.matches(selector);
      };
    }
    return function(value, index, array) {
      return value.nodeType === 1;
    };
  }
  var NodeObservationBehavior;
  var init_node_observation = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/templating/node-observation.js"() {
      init_observable();
      init_platform();
      NodeObservationBehavior = class {
        /**
         * Creates an instance of NodeObservationBehavior.
         * @param target - The target to assign the nodes property on.
         * @param options - The options to use in configuring node observation.
         */
        constructor(target, options) {
          this.target = target;
          this.options = options;
          this.source = null;
        }
        /**
         * Bind this behavior to the source.
         * @param source - The source to bind to.
         * @param context - The execution context that the binding is operating within.
         */
        bind(source) {
          const name = this.options.property;
          this.shouldUpdate = Observable.getAccessors(source).some((x) => x.name === name);
          this.source = source;
          this.updateTarget(this.computeNodes());
          if (this.shouldUpdate) {
            this.observe();
          }
        }
        /**
         * Unbinds this behavior from the source.
         * @param source - The source to unbind from.
         */
        unbind() {
          this.updateTarget(emptyArray);
          this.source = null;
          if (this.shouldUpdate) {
            this.disconnect();
          }
        }
        /** @internal */
        handleEvent() {
          this.updateTarget(this.computeNodes());
        }
        computeNodes() {
          let nodes = this.getNodes();
          if (this.options.filter !== void 0) {
            nodes = nodes.filter(this.options.filter);
          }
          return nodes;
        }
        updateTarget(value) {
          this.source[this.options.property] = value;
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/templating/slotted.js
  function slotted(propertyOrOptions) {
    if (typeof propertyOrOptions === "string") {
      propertyOrOptions = { property: propertyOrOptions };
    }
    return new AttachedBehaviorHTMLDirective("fast-slotted", SlottedBehavior, propertyOrOptions);
  }
  var SlottedBehavior;
  var init_slotted = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/templating/slotted.js"() {
      init_html_directive();
      init_node_observation();
      SlottedBehavior = class extends NodeObservationBehavior {
        /**
         * Creates an instance of SlottedBehavior.
         * @param target - The slot element target to observe.
         * @param options - The options to use when observing the slot.
         */
        constructor(target, options) {
          super(target, options);
        }
        /**
         * Begins observation of the nodes.
         */
        observe() {
          this.target.addEventListener("slotchange", this);
        }
        /**
         * Disconnects observation of the nodes.
         */
        disconnect() {
          this.target.removeEventListener("slotchange", this);
        }
        /**
         * Retrieves the nodes that should be assigned to the target.
         */
        getNodes() {
          return this.target.assignedNodes(this.options);
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/templating/children.js
  function children(propertyOrOptions) {
    if (typeof propertyOrOptions === "string") {
      propertyOrOptions = {
        property: propertyOrOptions
      };
    }
    return new AttachedBehaviorHTMLDirective("fast-children", ChildrenBehavior, propertyOrOptions);
  }
  var ChildrenBehavior;
  var init_children = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/templating/children.js"() {
      init_html_directive();
      init_node_observation();
      ChildrenBehavior = class extends NodeObservationBehavior {
        /**
         * Creates an instance of ChildrenBehavior.
         * @param target - The element target to observe children on.
         * @param options - The options to use when observing the element children.
         */
        constructor(target, options) {
          super(target, options);
          this.observer = null;
          options.childList = true;
        }
        /**
         * Begins observation of the nodes.
         */
        observe() {
          if (this.observer === null) {
            this.observer = new MutationObserver(this.handleEvent.bind(this));
          }
          this.observer.observe(this.target, this.options);
        }
        /**
         * Disconnects observation of the nodes.
         */
        disconnect() {
          this.observer.disconnect();
        }
        /**
         * Retrieves the nodes that should be assigned to the target.
         */
        getNodes() {
          if ("subtree" in this.options) {
            return Array.from(this.target.querySelectorAll(this.options.selector));
          }
          return Array.from(this.target.childNodes);
        }
      };
    }
  });

  // node_modules/@microsoft/fast-element/dist/esm/index.js
  var init_esm = __esm({
    "node_modules/@microsoft/fast-element/dist/esm/index.js"() {
      init_platform();
      init_template();
      init_fast_element();
      init_fast_definitions();
      init_attributes();
      init_controller();
      init_compiler();
      init_element_styles();
      init_css();
      init_css_directive();
      init_view();
      init_observable();
      init_notifier();
      init_dom();
      init_binding();
      init_html_directive();
      init_ref();
      init_when();
      init_repeat();
      init_slotted();
      init_children();
      init_node_observation();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/patterns/start-end.js
  var StartEnd, endSlotTemplate, startSlotTemplate, endTemplate, startTemplate;
  var init_start_end = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/patterns/start-end.js"() {
      init_esm();
      StartEnd = class {
        handleStartContentChange() {
          this.startContainer.classList.toggle("start", this.start.assignedNodes().length > 0);
        }
        handleEndContentChange() {
          this.endContainer.classList.toggle("end", this.end.assignedNodes().length > 0);
        }
      };
      endSlotTemplate = (context, definition) => html`
    <span
        part="end"
        ${ref("endContainer")}
        class=${(x) => definition.end ? "end" : void 0}
    >
        <slot name="end" ${ref("end")} @slotchange="${(x) => x.handleEndContentChange()}">
            ${definition.end || ""}
        </slot>
    </span>
`;
      startSlotTemplate = (context, definition) => html`
    <span
        part="start"
        ${ref("startContainer")}
        class="${(x) => definition.start ? "start" : void 0}"
    >
        <slot
            name="start"
            ${ref("start")}
            @slotchange="${(x) => x.handleStartContentChange()}"
        >
            ${definition.start || ""}
        </slot>
    </span>
`;
      endTemplate = html`
    <span part="end" ${ref("endContainer")}>
        <slot
            name="end"
            ${ref("end")}
            @slotchange="${(x) => x.handleEndContentChange()}"
        ></slot>
    </span>
`;
      startTemplate = html`
    <span part="start" ${ref("startContainer")}>
        <slot
            name="start"
            ${ref("start")}
            @slotchange="${(x) => x.handleStartContentChange()}"
        ></slot>
    </span>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/accordion-item/accordion-item.template.js
  var init_accordion_item_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/accordion-item/accordion-item.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/node_modules/tslib/tslib.es6.js
  function __decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
  }
  var init_tslib_es6 = __esm({
    "node_modules/@microsoft/fast-foundation/node_modules/tslib/tslib.es6.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/di/di.js
  function cloneArrayWithPossibleProps(source) {
    const clone = source.slice();
    const keys = Object.keys(source);
    const len = keys.length;
    let key;
    for (let i = 0; i < len; ++i) {
      key = keys[i];
      if (!isArrayIndex(key)) {
        clone[key] = source[key];
      }
    }
    return clone;
  }
  function getParamTypes(key) {
    return (Type) => {
      return Reflect.getOwnMetadata(key, Type);
    };
  }
  function createResolver(getter) {
    return function(key) {
      const resolver = function(target, property, descriptor) {
        DI.inject(resolver)(target, property, descriptor);
      };
      resolver.$isResolver = true;
      resolver.resolve = function(handler, requestor) {
        return getter(key, handler, requestor);
      };
      return resolver;
    };
  }
  function createAllResolver(getter) {
    return function(key, searchAncestors) {
      searchAncestors = !!searchAncestors;
      const resolver = function(target, property, descriptor) {
        DI.inject(resolver)(target, property, descriptor);
      };
      resolver.$isResolver = true;
      resolver.resolve = function(handler, requestor) {
        return getter(key, handler, requestor, searchAncestors);
      };
      return resolver;
    };
  }
  function ignore(target, property, descriptor) {
    DI.inject(ignore)(target, property, descriptor);
  }
  function createNewInstance(key, handler) {
    return handler.getFactory(key).construct(handler);
  }
  function containerGetKey(d) {
    return this.get(d);
  }
  function transformInstance(inst, transform) {
    return transform(inst);
  }
  function isRegistry(obj) {
    return typeof obj.register === "function";
  }
  function isSelfRegistry(obj) {
    return isRegistry(obj) && typeof obj.registerInRequestor === "boolean";
  }
  function isRegisterInRequester(obj) {
    return isSelfRegistry(obj) && obj.registerInRequestor;
  }
  function isClass(obj) {
    return obj.prototype !== void 0;
  }
  function cacheCallbackResult(fun) {
    return function(handler, requestor, resolver) {
      if (cache.has(resolver)) {
        return cache.get(resolver);
      }
      const t = fun(handler, requestor, resolver);
      cache.set(resolver, t);
      return t;
    };
  }
  function validateKey(key) {
    if (key === null || key === void 0) {
      throw new Error("key/value cannot be null or undefined. Are you trying to inject/register something that doesn't exist with DI?");
    }
  }
  function buildAllResponse(resolver, handler, requestor) {
    if (resolver instanceof ResolverImpl && resolver.strategy === 4) {
      const state = resolver.state;
      let i = state.length;
      const results = new Array(i);
      while (i--) {
        results[i] = state[i].resolve(handler, requestor);
      }
      return results;
    }
    return [resolver.resolve(handler, requestor)];
  }
  function isObject(value) {
    return typeof value === "object" && value !== null || typeof value === "function";
  }
  function isArrayIndex(value) {
    switch (typeof value) {
      case "number":
        return value >= 0 && (value | 0) === value;
      case "string": {
        const result = isNumericLookup[value];
        if (result !== void 0) {
          return result;
        }
        const length = value.length;
        if (length === 0) {
          return isNumericLookup[value] = false;
        }
        let ch = 0;
        for (let i = 0; i < length; ++i) {
          ch = value.charCodeAt(i);
          if (i === 0 && ch === 48 && length > 1 || ch < 48 || ch > 57) {
            return isNumericLookup[value] = false;
          }
        }
        return isNumericLookup[value] = true;
      }
      default:
        return false;
    }
  }
  var metadataByTarget, ResolverBuilder, DefaultResolver, ContainerConfiguration, dependencyLookup, rootDOMContainer, DI, Container, inject, defaultSingletonOptions, all, lazy, optional, newInstanceForScope, newInstanceOf, ResolverImpl, FactoryImpl, containerResolver, InstrinsicTypeNames, DILocateParentEventType, factories, ContainerImpl, cache, Registration, defaultFriendlyName, isNativeFunction, isNumericLookup;
  var init_di = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/di/di.js"() {
      init_esm();
      metadataByTarget = /* @__PURE__ */ new Map();
      if (!("metadata" in Reflect)) {
        Reflect.metadata = function(key, value) {
          return function(target) {
            Reflect.defineMetadata(key, value, target);
          };
        };
        Reflect.defineMetadata = function(key, value, target) {
          let metadata = metadataByTarget.get(target);
          if (metadata === void 0) {
            metadataByTarget.set(target, metadata = /* @__PURE__ */ new Map());
          }
          metadata.set(key, value);
        };
        Reflect.getOwnMetadata = function(key, target) {
          const metadata = metadataByTarget.get(target);
          if (metadata !== void 0) {
            return metadata.get(key);
          }
          return void 0;
        };
      }
      ResolverBuilder = class {
        /**
         *
         * @param container - The container to create resolvers for.
         * @param key - The key to register resolvers under.
         */
        constructor(container, key) {
          this.container = container;
          this.key = key;
        }
        /**
         * Creates a resolver for an existing object instance.
         * @param value - The instance to resolve.
         * @returns The resolver.
         */
        instance(value) {
          return this.registerResolver(0, value);
        }
        /**
         * Creates a resolver that enforces a singleton lifetime.
         * @param value - The type to create and cache the singleton for.
         * @returns The resolver.
         */
        singleton(value) {
          return this.registerResolver(1, value);
        }
        /**
         * Creates a resolver that creates a new instance for every dependency request.
         * @param value - The type to create instances of.
         * @returns - The resolver.
         */
        transient(value) {
          return this.registerResolver(2, value);
        }
        /**
         * Creates a resolver that invokes a callback function for every dependency resolution
         * request, allowing custom logic to return the dependency.
         * @param value - The callback to call during resolution.
         * @returns The resolver.
         */
        callback(value) {
          return this.registerResolver(3, value);
        }
        /**
         * Creates a resolver that invokes a callback function the first time that a dependency
         * resolution is requested. The returned value is then cached and provided for all
         * subsequent requests.
         * @param value - The callback to call during the first resolution.
         * @returns The resolver.
         */
        cachedCallback(value) {
          return this.registerResolver(3, cacheCallbackResult(value));
        }
        /**
         * Aliases the current key to a different key.
         * @param destinationKey - The key to point the alias to.
         * @returns The resolver.
         */
        aliasTo(destinationKey) {
          return this.registerResolver(5, destinationKey);
        }
        registerResolver(strategy, state) {
          const { container, key } = this;
          this.container = this.key = void 0;
          return container.registerResolver(key, new ResolverImpl(key, strategy, state));
        }
      };
      DefaultResolver = Object.freeze({
        /**
         * Disables auto-registration and throws for all un-registered dependencies.
         * @param key - The key to create the resolver for.
         */
        none(key) {
          throw Error(`${key.toString()} not registered, did you forget to add @singleton()?`);
        },
        /**
         * Provides default singleton resolution behavior during auto-registration.
         * @param key - The key to create the resolver for.
         * @returns The resolver.
         */
        singleton(key) {
          return new ResolverImpl(key, 1, key);
        },
        /**
         * Provides default transient resolution behavior during auto-registration.
         * @param key - The key to create the resolver for.
         * @returns The resolver.
         */
        transient(key) {
          return new ResolverImpl(key, 2, key);
        }
      });
      ContainerConfiguration = Object.freeze({
        /**
         * The default configuration used when creating a DOM-disconnected container.
         * @remarks
         * The default creates a root container, with no parent container. It does not handle
         * owner requests and it uses singleton resolution behavior for auto-registration.
         */
        default: Object.freeze({
          parentLocator: () => null,
          responsibleForOwnerRequests: false,
          defaultResolver: DefaultResolver.singleton
        })
      });
      dependencyLookup = /* @__PURE__ */ new Map();
      rootDOMContainer = null;
      DI = Object.freeze({
        /**
         * Creates a new dependency injection container.
         * @param config - The configuration for the container.
         * @returns A newly created dependency injection container.
         */
        createContainer(config) {
          return new ContainerImpl(null, Object.assign({}, ContainerConfiguration.default, config));
        },
        /**
         * Finds the dependency injection container responsible for providing dependencies
         * to the specified node.
         * @param node - The node to find the responsible container for.
         * @returns The container responsible for providing dependencies to the node.
         * @remarks
         * This will be the same as the parent container if the specified node
         * does not itself host a container configured with responsibleForOwnerRequests.
         */
        findResponsibleContainer(node) {
          const owned = node.$$container$$;
          if (owned && owned.responsibleForOwnerRequests) {
            return owned;
          }
          return DI.findParentContainer(node);
        },
        /**
         * Find the dependency injection container up the DOM tree from this node.
         * @param node - The node to find the parent container for.
         * @returns The parent container of this node.
         * @remarks
         * This will be the same as the responsible container if the specified node
         * does not itself host a container configured with responsibleForOwnerRequests.
         */
        findParentContainer(node) {
          const event = new CustomEvent(DILocateParentEventType, {
            bubbles: true,
            composed: true,
            cancelable: true,
            detail: { container: void 0 }
          });
          node.dispatchEvent(event);
          return event.detail.container || DI.getOrCreateDOMContainer();
        },
        /**
         * Returns a dependency injection container if one is explicitly owned by the specified
         * node. If one is not owned, then a new container is created and assigned to the node.
         * @param node - The node to find or create the container for.
         * @param config - The configuration for the container if one needs to be created.
         * @returns The located or created container.
         * @remarks
         * This API does not search for a responsible or parent container. It looks only for a container
         * directly defined on the specified node and creates one at that location if one does not
         * already exist.
         */
        getOrCreateDOMContainer(node, config) {
          if (!node) {
            return rootDOMContainer || (rootDOMContainer = new ContainerImpl(null, Object.assign({}, ContainerConfiguration.default, config, {
              parentLocator: () => null
            })));
          }
          return node.$$container$$ || new ContainerImpl(node, Object.assign({}, ContainerConfiguration.default, config, {
            parentLocator: DI.findParentContainer
          }));
        },
        /**
         * Gets the "design:paramtypes" metadata for the specified type.
         * @param Type - The type to get the metadata for.
         * @returns The metadata array or undefined if no metadata is found.
         */
        getDesignParamtypes: getParamTypes("design:paramtypes"),
        /**
         * Gets the "di:paramtypes" metadata for the specified type.
         * @param Type - The type to get the metadata for.
         * @returns The metadata array or undefined if no metadata is found.
         */
        getAnnotationParamtypes: getParamTypes("di:paramtypes"),
        /**
         *
         * @param Type - Gets the "di:paramtypes" metadata for the specified type. If none is found,
         * an empty metadata array is created and added.
         * @returns The metadata array.
         */
        getOrCreateAnnotationParamTypes(Type) {
          let annotationParamtypes = this.getAnnotationParamtypes(Type);
          if (annotationParamtypes === void 0) {
            Reflect.defineMetadata("di:paramtypes", annotationParamtypes = [], Type);
          }
          return annotationParamtypes;
        },
        /**
         * Gets the dependency keys representing what is needed to instantiate the specified type.
         * @param Type - The type to get the dependencies for.
         * @returns An array of dependency keys.
         */
        getDependencies(Type) {
          let dependencies = dependencyLookup.get(Type);
          if (dependencies === void 0) {
            const inject2 = Type.inject;
            if (inject2 === void 0) {
              const designParamtypes = DI.getDesignParamtypes(Type);
              const annotationParamtypes = DI.getAnnotationParamtypes(Type);
              if (designParamtypes === void 0) {
                if (annotationParamtypes === void 0) {
                  const Proto = Object.getPrototypeOf(Type);
                  if (typeof Proto === "function" && Proto !== Function.prototype) {
                    dependencies = cloneArrayWithPossibleProps(DI.getDependencies(Proto));
                  } else {
                    dependencies = [];
                  }
                } else {
                  dependencies = cloneArrayWithPossibleProps(annotationParamtypes);
                }
              } else if (annotationParamtypes === void 0) {
                dependencies = cloneArrayWithPossibleProps(designParamtypes);
              } else {
                dependencies = cloneArrayWithPossibleProps(designParamtypes);
                let len = annotationParamtypes.length;
                let auAnnotationParamtype;
                for (let i = 0; i < len; ++i) {
                  auAnnotationParamtype = annotationParamtypes[i];
                  if (auAnnotationParamtype !== void 0) {
                    dependencies[i] = auAnnotationParamtype;
                  }
                }
                const keys = Object.keys(annotationParamtypes);
                len = keys.length;
                let key;
                for (let i = 0; i < len; ++i) {
                  key = keys[i];
                  if (!isArrayIndex(key)) {
                    dependencies[key] = annotationParamtypes[key];
                  }
                }
              }
            } else {
              dependencies = cloneArrayWithPossibleProps(inject2);
            }
            dependencyLookup.set(Type, dependencies);
          }
          return dependencies;
        },
        /**
         * Defines a property on a web component class. The value of this property will
         * be resolved from the dependency injection container responsible for the element
         * instance, based on where it is connected in the DOM.
         * @param target - The target to define the property on.
         * @param propertyName - The name of the property to define.
         * @param key - The dependency injection key.
         * @param respectConnection - Indicates whether or not to update the property value if the
         * hosting component is disconnected and then re-connected at a different location in the DOM.
         * @remarks
         * The respectConnection option is only applicable to elements that descend from FASTElement.
         */
        defineProperty(target, propertyName, key, respectConnection = false) {
          const diPropertyKey = `$di_${propertyName}`;
          Reflect.defineProperty(target, propertyName, {
            get: function() {
              let value = this[diPropertyKey];
              if (value === void 0) {
                const container = this instanceof HTMLElement ? DI.findResponsibleContainer(this) : DI.getOrCreateDOMContainer();
                value = container.get(key);
                this[diPropertyKey] = value;
                if (respectConnection && this instanceof FASTElement) {
                  const notifier = this.$fastController;
                  const handleChange = () => {
                    const newContainer = DI.findResponsibleContainer(this);
                    const newValue = newContainer.get(key);
                    const oldValue = this[diPropertyKey];
                    if (newValue !== oldValue) {
                      this[diPropertyKey] = value;
                      notifier.notify(propertyName);
                    }
                  };
                  notifier.subscribe({ handleChange }, "isConnected");
                }
              }
              return value;
            }
          });
        },
        /**
         * Creates a dependency injection key.
         * @param nameConfigOrCallback - A friendly name for the key or a lambda that configures a
         * default resolution for the dependency.
         * @param configuror - If a friendly name was provided for the first parameter, then an optional
         * lambda that configures a default resolution for the dependency can be provided second.
         * @returns The created key.
         * @remarks
         * The created key can be used as a property decorator or constructor parameter decorator,
         * in addition to its standard use in an inject array or through direct container APIs.
         */
        createInterface(nameConfigOrCallback, configuror) {
          const configure = typeof nameConfigOrCallback === "function" ? nameConfigOrCallback : configuror;
          const friendlyName = typeof nameConfigOrCallback === "string" ? nameConfigOrCallback : nameConfigOrCallback && "friendlyName" in nameConfigOrCallback ? nameConfigOrCallback.friendlyName || defaultFriendlyName : defaultFriendlyName;
          const respectConnection = typeof nameConfigOrCallback === "string" ? false : nameConfigOrCallback && "respectConnection" in nameConfigOrCallback ? nameConfigOrCallback.respectConnection || false : false;
          const Interface = function(target, property, index) {
            if (target == null || new.target !== void 0) {
              throw new Error(`No registration for interface: '${Interface.friendlyName}'`);
            }
            if (property) {
              DI.defineProperty(target, property, Interface, respectConnection);
            } else {
              const annotationParamtypes = DI.getOrCreateAnnotationParamTypes(target);
              annotationParamtypes[index] = Interface;
            }
          };
          Interface.$isInterface = true;
          Interface.friendlyName = friendlyName == null ? "(anonymous)" : friendlyName;
          if (configure != null) {
            Interface.register = function(container, key) {
              return configure(new ResolverBuilder(container, key !== null && key !== void 0 ? key : Interface));
            };
          }
          Interface.toString = function toString() {
            return `InterfaceSymbol<${Interface.friendlyName}>`;
          };
          return Interface;
        },
        /**
         * A decorator that specifies what to inject into its target.
         * @param dependencies - The dependencies to inject.
         * @returns The decorator to be applied to the target class.
         * @remarks
         * The decorator can be used to decorate a class, listing all of the classes dependencies.
         * Or it can be used to decorate a constructor paramter, indicating what to inject for that
         * parameter.
         * Or it can be used for a web component property, indicating what that property should resolve to.
         */
        inject(...dependencies) {
          return function(target, key, descriptor) {
            if (typeof descriptor === "number") {
              const annotationParamtypes = DI.getOrCreateAnnotationParamTypes(target);
              const dep = dependencies[0];
              if (dep !== void 0) {
                annotationParamtypes[descriptor] = dep;
              }
            } else if (key) {
              DI.defineProperty(target, key, dependencies[0]);
            } else {
              const annotationParamtypes = descriptor ? DI.getOrCreateAnnotationParamTypes(descriptor.value) : DI.getOrCreateAnnotationParamTypes(target);
              let dep;
              for (let i = 0; i < dependencies.length; ++i) {
                dep = dependencies[i];
                if (dep !== void 0) {
                  annotationParamtypes[i] = dep;
                }
              }
            }
          };
        },
        /**
         * Registers the `target` class as a transient dependency; each time the dependency is resolved
         * a new instance will be created.
         *
         * @param target - The class / constructor function to register as transient.
         * @returns The same class, with a static `register` method that takes a container and returns the appropriate resolver.
         *
         * @example
         * On an existing class
         * ```ts
         * class Foo { }
         * DI.transient(Foo);
         * ```
         *
         * @example
         * Inline declaration
         *
         * ```ts
         * const Foo = DI.transient(class { });
         * // Foo is now strongly typed with register
         * Foo.register(container);
         * ```
         *
         * @public
         */
        transient(target) {
          target.register = function register(container) {
            const registration = Registration.transient(target, target);
            return registration.register(container);
          };
          target.registerInRequestor = false;
          return target;
        },
        /**
         * Registers the `target` class as a singleton dependency; the class will only be created once. Each
         * consecutive time the dependency is resolved, the same instance will be returned.
         *
         * @param target - The class / constructor function to register as a singleton.
         * @returns The same class, with a static `register` method that takes a container and returns the appropriate resolver.
         * @example
         * On an existing class
         * ```ts
         * class Foo { }
         * DI.singleton(Foo);
         * ```
         *
         * @example
         * Inline declaration
         * ```ts
         * const Foo = DI.singleton(class { });
         * // Foo is now strongly typed with register
         * Foo.register(container);
         * ```
         *
         * @public
         */
        singleton(target, options = defaultSingletonOptions) {
          target.register = function register(container) {
            const registration = Registration.singleton(target, target);
            return registration.register(container);
          };
          target.registerInRequestor = options.scoped;
          return target;
        }
      });
      Container = DI.createInterface("Container");
      inject = DI.inject;
      defaultSingletonOptions = { scoped: false };
      all = createAllResolver((key, handler, requestor, searchAncestors) => requestor.getAll(key, searchAncestors));
      lazy = createResolver((key, handler, requestor) => {
        return () => requestor.get(key);
      });
      optional = createResolver((key, handler, requestor) => {
        if (requestor.has(key, true)) {
          return requestor.get(key);
        } else {
          return void 0;
        }
      });
      ignore.$isResolver = true;
      ignore.resolve = () => void 0;
      newInstanceForScope = createResolver((key, handler, requestor) => {
        const instance = createNewInstance(key, handler);
        const resolver = new ResolverImpl(key, 0, instance);
        requestor.registerResolver(key, resolver);
        return instance;
      });
      newInstanceOf = createResolver((key, handler, _requestor) => createNewInstance(key, handler));
      ResolverImpl = class {
        constructor(key, strategy, state) {
          this.key = key;
          this.strategy = strategy;
          this.state = state;
          this.resolving = false;
        }
        get $isResolver() {
          return true;
        }
        register(container) {
          return container.registerResolver(this.key, this);
        }
        resolve(handler, requestor) {
          switch (this.strategy) {
            case 0:
              return this.state;
            case 1: {
              if (this.resolving) {
                throw new Error(`Cyclic dependency found: ${this.state.name}`);
              }
              this.resolving = true;
              this.state = handler.getFactory(this.state).construct(requestor);
              this.strategy = 0;
              this.resolving = false;
              return this.state;
            }
            case 2: {
              const factory = handler.getFactory(this.state);
              if (factory === null) {
                throw new Error(`Resolver for ${String(this.key)} returned a null factory`);
              }
              return factory.construct(requestor);
            }
            case 3:
              return this.state(handler, requestor, this);
            case 4:
              return this.state[0].resolve(handler, requestor);
            case 5:
              return requestor.get(this.state);
            default:
              throw new Error(`Invalid resolver strategy specified: ${this.strategy}.`);
          }
        }
        getFactory(container) {
          var _a, _b, _c;
          switch (this.strategy) {
            case 1:
            case 2:
              return container.getFactory(this.state);
            case 5:
              return (_c = (_b = (_a = container.getResolver(this.state)) === null || _a === void 0 ? void 0 : _a.getFactory) === null || _b === void 0 ? void 0 : _b.call(_a, container)) !== null && _c !== void 0 ? _c : null;
            default:
              return null;
          }
        }
      };
      FactoryImpl = class {
        constructor(Type, dependencies) {
          this.Type = Type;
          this.dependencies = dependencies;
          this.transformers = null;
        }
        construct(container, dynamicDependencies) {
          let instance;
          if (dynamicDependencies === void 0) {
            instance = new this.Type(...this.dependencies.map(containerGetKey, container));
          } else {
            instance = new this.Type(...this.dependencies.map(containerGetKey, container), ...dynamicDependencies);
          }
          if (this.transformers == null) {
            return instance;
          }
          return this.transformers.reduce(transformInstance, instance);
        }
        registerTransformer(transformer) {
          (this.transformers || (this.transformers = [])).push(transformer);
        }
      };
      containerResolver = {
        $isResolver: true,
        resolve(handler, requestor) {
          return requestor;
        }
      };
      InstrinsicTypeNames = /* @__PURE__ */ new Set([
        "Array",
        "ArrayBuffer",
        "Boolean",
        "DataView",
        "Date",
        "Error",
        "EvalError",
        "Float32Array",
        "Float64Array",
        "Function",
        "Int8Array",
        "Int16Array",
        "Int32Array",
        "Map",
        "Number",
        "Object",
        "Promise",
        "RangeError",
        "ReferenceError",
        "RegExp",
        "Set",
        "SharedArrayBuffer",
        "String",
        "SyntaxError",
        "TypeError",
        "Uint8Array",
        "Uint8ClampedArray",
        "Uint16Array",
        "Uint32Array",
        "URIError",
        "WeakMap",
        "WeakSet"
      ]);
      DILocateParentEventType = "__DI_LOCATE_PARENT__";
      factories = /* @__PURE__ */ new Map();
      ContainerImpl = class _ContainerImpl {
        constructor(owner, config) {
          this.owner = owner;
          this.config = config;
          this._parent = void 0;
          this.registerDepth = 0;
          this.context = null;
          if (owner !== null) {
            owner.$$container$$ = this;
          }
          this.resolvers = /* @__PURE__ */ new Map();
          this.resolvers.set(Container, containerResolver);
          if (owner instanceof Node) {
            owner.addEventListener(DILocateParentEventType, (e) => {
              if (e.composedPath()[0] !== this.owner) {
                e.detail.container = this;
                e.stopImmediatePropagation();
              }
            });
          }
        }
        get parent() {
          if (this._parent === void 0) {
            this._parent = this.config.parentLocator(this.owner);
          }
          return this._parent;
        }
        get depth() {
          return this.parent === null ? 0 : this.parent.depth + 1;
        }
        get responsibleForOwnerRequests() {
          return this.config.responsibleForOwnerRequests;
        }
        registerWithContext(context, ...params) {
          this.context = context;
          this.register(...params);
          this.context = null;
          return this;
        }
        register(...params) {
          if (++this.registerDepth === 100) {
            throw new Error("Unable to autoregister dependency");
          }
          let current;
          let keys;
          let value;
          let j;
          let jj;
          const context = this.context;
          for (let i = 0, ii = params.length; i < ii; ++i) {
            current = params[i];
            if (!isObject(current)) {
              continue;
            }
            if (isRegistry(current)) {
              current.register(this, context);
            } else if (isClass(current)) {
              Registration.singleton(current, current).register(this);
            } else {
              keys = Object.keys(current);
              j = 0;
              jj = keys.length;
              for (; j < jj; ++j) {
                value = current[keys[j]];
                if (!isObject(value)) {
                  continue;
                }
                if (isRegistry(value)) {
                  value.register(this, context);
                } else {
                  this.register(value);
                }
              }
            }
          }
          --this.registerDepth;
          return this;
        }
        registerResolver(key, resolver) {
          validateKey(key);
          const resolvers = this.resolvers;
          const result = resolvers.get(key);
          if (result == null) {
            resolvers.set(key, resolver);
          } else if (result instanceof ResolverImpl && result.strategy === 4) {
            result.state.push(resolver);
          } else {
            resolvers.set(key, new ResolverImpl(key, 4, [result, resolver]));
          }
          return resolver;
        }
        registerTransformer(key, transformer) {
          const resolver = this.getResolver(key);
          if (resolver == null) {
            return false;
          }
          if (resolver.getFactory) {
            const factory = resolver.getFactory(this);
            if (factory == null) {
              return false;
            }
            factory.registerTransformer(transformer);
            return true;
          }
          return false;
        }
        getResolver(key, autoRegister = true) {
          validateKey(key);
          if (key.resolve !== void 0) {
            return key;
          }
          let current = this;
          let resolver;
          while (current != null) {
            resolver = current.resolvers.get(key);
            if (resolver == null) {
              if (current.parent == null) {
                const handler = isRegisterInRequester(key) ? this : current;
                return autoRegister ? this.jitRegister(key, handler) : null;
              }
              current = current.parent;
            } else {
              return resolver;
            }
          }
          return null;
        }
        has(key, searchAncestors = false) {
          return this.resolvers.has(key) ? true : searchAncestors && this.parent != null ? this.parent.has(key, true) : false;
        }
        get(key) {
          validateKey(key);
          if (key.$isResolver) {
            return key.resolve(this, this);
          }
          let current = this;
          let resolver;
          while (current != null) {
            resolver = current.resolvers.get(key);
            if (resolver == null) {
              if (current.parent == null) {
                const handler = isRegisterInRequester(key) ? this : current;
                resolver = this.jitRegister(key, handler);
                return resolver.resolve(current, this);
              }
              current = current.parent;
            } else {
              return resolver.resolve(current, this);
            }
          }
          throw new Error(`Unable to resolve key: ${String(key)}`);
        }
        getAll(key, searchAncestors = false) {
          validateKey(key);
          const requestor = this;
          let current = requestor;
          let resolver;
          if (searchAncestors) {
            let resolutions = emptyArray;
            while (current != null) {
              resolver = current.resolvers.get(key);
              if (resolver != null) {
                resolutions = resolutions.concat(
                  /* eslint-disable-next-line @typescript-eslint/no-non-null-assertion */
                  buildAllResponse(resolver, current, requestor)
                );
              }
              current = current.parent;
            }
            return resolutions;
          } else {
            while (current != null) {
              resolver = current.resolvers.get(key);
              if (resolver == null) {
                current = current.parent;
                if (current == null) {
                  return emptyArray;
                }
              } else {
                return buildAllResponse(resolver, current, requestor);
              }
            }
          }
          return emptyArray;
        }
        getFactory(Type) {
          let factory = factories.get(Type);
          if (factory === void 0) {
            if (isNativeFunction(Type)) {
              throw new Error(`${Type.name} is a native function and therefore cannot be safely constructed by DI. If this is intentional, please use a callback or cachedCallback resolver.`);
            }
            factories.set(Type, factory = new FactoryImpl(Type, DI.getDependencies(Type)));
          }
          return factory;
        }
        registerFactory(key, factory) {
          factories.set(key, factory);
        }
        createChild(config) {
          return new _ContainerImpl(null, Object.assign({}, this.config, config, { parentLocator: () => this }));
        }
        jitRegister(keyAsValue, handler) {
          if (typeof keyAsValue !== "function") {
            throw new Error(`Attempted to jitRegister something that is not a constructor: '${keyAsValue}'. Did you forget to register this dependency?`);
          }
          if (InstrinsicTypeNames.has(keyAsValue.name)) {
            throw new Error(`Attempted to jitRegister an intrinsic type: ${keyAsValue.name}. Did you forget to add @inject(Key)`);
          }
          if (isRegistry(keyAsValue)) {
            const registrationResolver = keyAsValue.register(handler);
            if (!(registrationResolver instanceof Object) || registrationResolver.resolve == null) {
              const newResolver = handler.resolvers.get(keyAsValue);
              if (newResolver != void 0) {
                return newResolver;
              }
              throw new Error("A valid resolver was not returned from the static register method");
            }
            return registrationResolver;
          } else if (keyAsValue.$isInterface) {
            throw new Error(`Attempted to jitRegister an interface: ${keyAsValue.friendlyName}`);
          } else {
            const resolver = this.config.defaultResolver(keyAsValue, handler);
            handler.resolvers.set(keyAsValue, resolver);
            return resolver;
          }
        }
      };
      cache = /* @__PURE__ */ new WeakMap();
      Registration = Object.freeze({
        /**
         * Allows you to pass an instance.
         * Every time you request this {@link Key} you will get this instance back.
         *
         * @example
         * ```
         * Registration.instance(Foo, new Foo()));
         * ```
         *
         * @param key - The key to register the instance under.
         * @param value - The instance to return when the key is requested.
         */
        instance(key, value) {
          return new ResolverImpl(key, 0, value);
        },
        /**
         * Creates an instance from the class.
         * Every time you request this {@link Key} you will get the same one back.
         *
         * @example
         * ```
         * Registration.singleton(Foo, Foo);
         * ```
         *
         * @param key - The key to register the singleton under.
         * @param value - The class to instantiate as a singleton when first requested.
         */
        singleton(key, value) {
          return new ResolverImpl(key, 1, value);
        },
        /**
         * Creates an instance from a class.
         * Every time you request this {@link Key} you will get a new instance.
         *
         * @example
         * ```
         * Registration.instance(Foo, Foo);
         * ```
         *
         * @param key - The key to register the instance type under.
         * @param value - The class to instantiate each time the key is requested.
         */
        transient(key, value) {
          return new ResolverImpl(key, 2, value);
        },
        /**
         * Delegates to a callback function to provide the dependency.
         * Every time you request this {@link Key} the callback will be invoked to provide
         * the dependency.
         *
         * @example
         * ```
         * Registration.callback(Foo, () => new Foo());
         * Registration.callback(Bar, (c: Container) => new Bar(c.get(Foo)));
         * ```
         *
         * @param key - The key to register the callback for.
         * @param callback - The function that is expected to return the dependency.
         */
        callback(key, callback) {
          return new ResolverImpl(key, 3, callback);
        },
        /**
         * Delegates to a callback function to provide the dependency and then caches the
         * dependency for future requests.
         *
         * @example
         * ```
         * Registration.cachedCallback(Foo, () => new Foo());
         * Registration.cachedCallback(Bar, (c: Container) => new Bar(c.get(Foo)));
         * ```
         *
         * @param key - The key to register the callback for.
         * @param callback - The function that is expected to return the dependency.
         * @remarks
         * If you pass the same Registration to another container, the same cached value will be used.
         * Should all references to the resolver returned be removed, the cache will expire.
         */
        cachedCallback(key, callback) {
          return new ResolverImpl(key, 3, cacheCallbackResult(callback));
        },
        /**
         * Creates an alternate {@link Key} to retrieve an instance by.
         *
         * @example
         * ```
         * Register.singleton(Foo, Foo)
         * Register.aliasTo(Foo, MyFoos);
         *
         * container.getAll(MyFoos) // contains an instance of Foo
         * ```
         *
         * @param originalKey - The original key that has been registered.
         * @param aliasKey - The alias to the original key.
         */
        aliasTo(originalKey, aliasKey) {
          return new ResolverImpl(aliasKey, 5, originalKey);
        }
      });
      defaultFriendlyName = "(anonymous)";
      isNativeFunction = /* @__PURE__ */ (function() {
        const lookup = /* @__PURE__ */ new WeakMap();
        let isNative = false;
        let sourceText = "";
        let i = 0;
        return function(fn) {
          isNative = lookup.get(fn);
          if (isNative === void 0) {
            sourceText = fn.toString();
            i = sourceText.length;
            isNative = // 29 is the length of 'function () { [native code] }' which is the smallest length of a native function string
            i >= 29 && // 100 seems to be a safe upper bound of the max length of a native function. In Chrome and FF it's 56, in Edge it's 61.
            i <= 100 && // This whole heuristic *could* be tricked by a comment. Do we need to care about that?
            sourceText.charCodeAt(i - 1) === 125 && // }
            // TODO: the spec is a little vague about the precise constraints, so we do need to test this across various browsers to make sure just one whitespace is a safe assumption.
            sourceText.charCodeAt(i - 2) <= 32 && // whitespace
            sourceText.charCodeAt(i - 3) === 93 && // ]
            sourceText.charCodeAt(i - 4) === 101 && // e
            sourceText.charCodeAt(i - 5) === 100 && // d
            sourceText.charCodeAt(i - 6) === 111 && // o
            sourceText.charCodeAt(i - 7) === 99 && // c
            sourceText.charCodeAt(i - 8) === 32 && //
            sourceText.charCodeAt(i - 9) === 101 && // e
            sourceText.charCodeAt(i - 10) === 118 && // v
            sourceText.charCodeAt(i - 11) === 105 && // i
            sourceText.charCodeAt(i - 12) === 116 && // t
            sourceText.charCodeAt(i - 13) === 97 && // a
            sourceText.charCodeAt(i - 14) === 110 && // n
            sourceText.charCodeAt(i - 15) === 88;
            lookup.set(fn, isNative);
          }
          return isNative;
        };
      })();
      isNumericLookup = {};
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/design-system/component-presentation.js
  function presentationKeyFromTag(tagName) {
    return `${tagName.toLowerCase()}:presentation`;
  }
  var presentationRegistry, ComponentPresentation, DefaultComponentPresentation;
  var init_component_presentation = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/design-system/component-presentation.js"() {
      init_esm();
      init_di();
      presentationRegistry = /* @__PURE__ */ new Map();
      ComponentPresentation = Object.freeze({
        /**
         * Defines a component presentation for an element.
         * @param tagName - The element name to define the presentation for.
         * @param presentation - The presentation that will be applied to matching elements.
         * @param container - The dependency injection container to register the configuration in.
         * @public
         */
        define(tagName, presentation, container) {
          const key = presentationKeyFromTag(tagName);
          const existing = presentationRegistry.get(key);
          if (existing === void 0) {
            presentationRegistry.set(key, presentation);
          } else {
            presentationRegistry.set(key, false);
          }
          container.register(Registration.instance(key, presentation));
        },
        /**
         * Finds a component presentation for the specified element name,
         * searching the DOM hierarchy starting from the provided element.
         * @param tagName - The name of the element to locate the presentation for.
         * @param element - The element to begin the search from.
         * @returns The component presentation or null if none is found.
         * @public
         */
        forTag(tagName, element) {
          const key = presentationKeyFromTag(tagName);
          const existing = presentationRegistry.get(key);
          if (existing === false) {
            const container = DI.findResponsibleContainer(element);
            return container.get(key);
          }
          return existing || null;
        }
      });
      DefaultComponentPresentation = class {
        /**
         * Creates an instance of DefaultComponentPresentation.
         * @param template - The template to apply to the element.
         * @param styles - The styles to apply to the element.
         * @public
         */
        constructor(template, styles) {
          this.template = template || null;
          this.styles = styles === void 0 ? null : Array.isArray(styles) ? ElementStyles.create(styles) : styles instanceof ElementStyles ? styles : ElementStyles.create([styles]);
        }
        /**
         * Applies the presentation details to the specified element.
         * @param element - The element to apply the presentation details to.
         * @public
         */
        applyTo(element) {
          const controller = element.$fastController;
          if (controller.template === null) {
            controller.template = this.template;
          }
          if (controller.styles === null) {
            controller.styles = this.styles;
          }
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/foundation-element/foundation-element.js
  function resolveOption(option, context, definition) {
    if (typeof option === "function") {
      return option(context, definition);
    }
    return option;
  }
  var FoundationElement, FoundationElementRegistry;
  var init_foundation_element = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/foundation-element/foundation-element.js"() {
      init_tslib_es6();
      init_esm();
      init_component_presentation();
      FoundationElement = class _FoundationElement extends FASTElement {
        constructor() {
          super(...arguments);
          this._presentation = void 0;
        }
        /**
         * A property which resolves the ComponentPresentation instance
         * for the current component.
         * @public
         */
        get $presentation() {
          if (this._presentation === void 0) {
            this._presentation = ComponentPresentation.forTag(this.tagName, this);
          }
          return this._presentation;
        }
        templateChanged() {
          if (this.template !== void 0) {
            this.$fastController.template = this.template;
          }
        }
        stylesChanged() {
          if (this.styles !== void 0) {
            this.$fastController.styles = this.styles;
          }
        }
        /**
         * The connected callback for this FASTElement.
         * @remarks
         * This method is invoked by the platform whenever this FoundationElement
         * becomes connected to the document.
         * @public
         */
        connectedCallback() {
          if (this.$presentation !== null) {
            this.$presentation.applyTo(this);
          }
          super.connectedCallback();
        }
        /**
         * Defines an element registry function with a set of element definition defaults.
         * @param elementDefinition - The definition of the element to create the registry
         * function for.
         * @public
         */
        static compose(elementDefinition) {
          return (overrideDefinition = {}) => new FoundationElementRegistry(this === _FoundationElement ? class extends _FoundationElement {
          } : this, elementDefinition, overrideDefinition);
        }
      };
      __decorate([
        observable
      ], FoundationElement.prototype, "template", void 0);
      __decorate([
        observable
      ], FoundationElement.prototype, "styles", void 0);
      FoundationElementRegistry = class {
        constructor(type, elementDefinition, overrideDefinition) {
          this.type = type;
          this.elementDefinition = elementDefinition;
          this.overrideDefinition = overrideDefinition;
          this.definition = Object.assign(Object.assign({}, this.elementDefinition), this.overrideDefinition);
        }
        register(container, context) {
          const definition = this.definition;
          const overrideDefinition = this.overrideDefinition;
          const prefix = definition.prefix || context.elementPrefix;
          const name = `${prefix}-${definition.baseName}`;
          context.tryDefineElement({
            name,
            type: this.type,
            baseClass: this.elementDefinition.baseClass,
            callback: (x) => {
              const presentation = new DefaultComponentPresentation(resolveOption(definition.template, x, definition), resolveOption(definition.styles, x, definition));
              x.definePresentation(presentation);
              let shadowOptions = resolveOption(definition.shadowOptions, x, definition);
              if (x.shadowRootMode) {
                if (shadowOptions) {
                  if (!overrideDefinition.shadowOptions) {
                    shadowOptions.mode = x.shadowRootMode;
                  }
                } else if (shadowOptions !== null) {
                  shadowOptions = { mode: x.shadowRootMode };
                }
              }
              x.defineElement({
                elementOptions: resolveOption(definition.elementOptions, x, definition),
                shadowOptions,
                attributes: resolveOption(definition.attributes, x, definition)
              });
            }
          });
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/apply-mixins.js
  function applyMixins(derivedCtor, ...baseCtors) {
    const derivedAttributes = AttributeConfiguration.locate(derivedCtor);
    baseCtors.forEach((baseCtor) => {
      Object.getOwnPropertyNames(baseCtor.prototype).forEach((name) => {
        if (name !== "constructor") {
          Object.defineProperty(
            derivedCtor.prototype,
            name,
            /* eslint-disable-next-line @typescript-eslint/no-non-null-assertion */
            Object.getOwnPropertyDescriptor(baseCtor.prototype, name)
          );
        }
      });
      const baseAttributes = AttributeConfiguration.locate(baseCtor);
      baseAttributes.forEach((x) => derivedAttributes.push(x));
    });
  }
  var init_apply_mixins = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/apply-mixins.js"() {
      init_esm();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/accordion-item/accordion-item.js
  var AccordionItem;
  var init_accordion_item = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/accordion-item/accordion-item.js"() {
      init_tslib_es6();
      init_esm();
      init_foundation_element();
      init_start_end();
      init_apply_mixins();
      AccordionItem = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.headinglevel = 2;
          this.expanded = false;
          this.clickHandler = (e) => {
            this.expanded = !this.expanded;
            this.change();
          };
          this.change = () => {
            this.$emit("change");
          };
        }
      };
      __decorate([
        attr({
          attribute: "heading-level",
          mode: "fromView",
          converter: nullableNumberConverter
        })
      ], AccordionItem.prototype, "headinglevel", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], AccordionItem.prototype, "expanded", void 0);
      __decorate([
        attr
      ], AccordionItem.prototype, "id", void 0);
      applyMixins(AccordionItem, StartEnd);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/accordion-item/index.js
  var init_accordion_item2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/accordion-item/index.js"() {
      init_accordion_item_template();
      init_accordion_item();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/accordion/accordion.template.js
  var init_accordion_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/accordion/accordion.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/aria.js
  var Orientation;
  var init_aria = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/aria.js"() {
      Orientation = {
        horizontal: "horizontal",
        vertical: "vertical"
      };
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/array.js
  function findLastIndex(array, predicate) {
    let k = array.length;
    while (k--) {
      if (predicate(array[k], k, array)) {
        return k;
      }
    }
    return -1;
  }
  var init_array = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/array.js"() {
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/class-names.js
  var init_class_names = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/class-names.js"() {
    }
  });

  // node_modules/exenv-es6/dist/can-use-dom.js
  function canUseDOM() {
    return !!(typeof window !== "undefined" && window.document && window.document.createElement);
  }
  var init_can_use_dom = __esm({
    "node_modules/exenv-es6/dist/can-use-dom.js"() {
    }
  });

  // node_modules/exenv-es6/dist/can-use-event-listeners.js
  var init_can_use_event_listeners = __esm({
    "node_modules/exenv-es6/dist/can-use-event-listeners.js"() {
    }
  });

  // node_modules/exenv-es6/dist/can-use-viewport.js
  var init_can_use_viewport = __esm({
    "node_modules/exenv-es6/dist/can-use-viewport.js"() {
    }
  });

  // node_modules/exenv-es6/dist/can-use-workers.js
  var init_can_use_workers = __esm({
    "node_modules/exenv-es6/dist/can-use-workers.js"() {
    }
  });

  // node_modules/exenv-es6/dist/index.js
  var init_dist = __esm({
    "node_modules/exenv-es6/dist/index.js"() {
      init_can_use_dom();
      init_can_use_event_listeners();
      init_can_use_viewport();
      init_can_use_workers();
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/dom.js
  function isHTMLElement(...args) {
    return args.every((arg) => arg instanceof HTMLElement);
  }
  function getDisplayedNodes(rootNode, selector) {
    if (!rootNode || !selector || !isHTMLElement(rootNode)) {
      return;
    }
    const nodes = Array.from(rootNode.querySelectorAll(selector));
    return nodes.filter((node) => node.offsetParent !== null);
  }
  function getNonce() {
    const node = document.querySelector('meta[property="csp-nonce"]');
    if (node) {
      return node.getAttribute("content");
    } else {
      return null;
    }
  }
  function canUseFocusVisible() {
    if (typeof _canUseFocusVisible === "boolean") {
      return _canUseFocusVisible;
    }
    if (!canUseDOM()) {
      _canUseFocusVisible = false;
      return _canUseFocusVisible;
    }
    const styleElement = document.createElement("style");
    const styleNonce = getNonce();
    if (styleNonce !== null) {
      styleElement.setAttribute("nonce", styleNonce);
    }
    document.head.appendChild(styleElement);
    try {
      styleElement.sheet.insertRule("foo:focus-visible {color:inherit}", 0);
      _canUseFocusVisible = true;
    } catch (e) {
      _canUseFocusVisible = false;
    } finally {
      document.head.removeChild(styleElement);
    }
    return _canUseFocusVisible;
  }
  var _canUseFocusVisible;
  var init_dom2 = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/dom.js"() {
      init_dist();
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/events.js
  var eventFocus, eventFocusIn, eventFocusOut, eventKeyDown, eventResize, eventScroll;
  var init_events = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/events.js"() {
      eventFocus = "focus";
      eventFocusIn = "focusin";
      eventFocusOut = "focusout";
      eventKeyDown = "keydown";
      eventResize = "resize";
      eventScroll = "scroll";
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/html.js
  var init_html = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/html.js"() {
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/key-codes.js
  var KeyCodes, keyArrowDown, keyArrowLeft, keyArrowRight, keyArrowUp, keyEnter, keyEscape, keyHome, keyEnd, keyFunction2, keyPageDown, keyPageUp, keySpace, keyTab, keyBackspace, keyDelete, ArrowKeys;
  var init_key_codes = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/key-codes.js"() {
      (function(KeyCodes2) {
        KeyCodes2[KeyCodes2["alt"] = 18] = "alt";
        KeyCodes2[KeyCodes2["arrowDown"] = 40] = "arrowDown";
        KeyCodes2[KeyCodes2["arrowLeft"] = 37] = "arrowLeft";
        KeyCodes2[KeyCodes2["arrowRight"] = 39] = "arrowRight";
        KeyCodes2[KeyCodes2["arrowUp"] = 38] = "arrowUp";
        KeyCodes2[KeyCodes2["back"] = 8] = "back";
        KeyCodes2[KeyCodes2["backSlash"] = 220] = "backSlash";
        KeyCodes2[KeyCodes2["break"] = 19] = "break";
        KeyCodes2[KeyCodes2["capsLock"] = 20] = "capsLock";
        KeyCodes2[KeyCodes2["closeBracket"] = 221] = "closeBracket";
        KeyCodes2[KeyCodes2["colon"] = 186] = "colon";
        KeyCodes2[KeyCodes2["colon2"] = 59] = "colon2";
        KeyCodes2[KeyCodes2["comma"] = 188] = "comma";
        KeyCodes2[KeyCodes2["ctrl"] = 17] = "ctrl";
        KeyCodes2[KeyCodes2["delete"] = 46] = "delete";
        KeyCodes2[KeyCodes2["end"] = 35] = "end";
        KeyCodes2[KeyCodes2["enter"] = 13] = "enter";
        KeyCodes2[KeyCodes2["equals"] = 187] = "equals";
        KeyCodes2[KeyCodes2["equals2"] = 61] = "equals2";
        KeyCodes2[KeyCodes2["equals3"] = 107] = "equals3";
        KeyCodes2[KeyCodes2["escape"] = 27] = "escape";
        KeyCodes2[KeyCodes2["forwardSlash"] = 191] = "forwardSlash";
        KeyCodes2[KeyCodes2["function1"] = 112] = "function1";
        KeyCodes2[KeyCodes2["function10"] = 121] = "function10";
        KeyCodes2[KeyCodes2["function11"] = 122] = "function11";
        KeyCodes2[KeyCodes2["function12"] = 123] = "function12";
        KeyCodes2[KeyCodes2["function2"] = 113] = "function2";
        KeyCodes2[KeyCodes2["function3"] = 114] = "function3";
        KeyCodes2[KeyCodes2["function4"] = 115] = "function4";
        KeyCodes2[KeyCodes2["function5"] = 116] = "function5";
        KeyCodes2[KeyCodes2["function6"] = 117] = "function6";
        KeyCodes2[KeyCodes2["function7"] = 118] = "function7";
        KeyCodes2[KeyCodes2["function8"] = 119] = "function8";
        KeyCodes2[KeyCodes2["function9"] = 120] = "function9";
        KeyCodes2[KeyCodes2["home"] = 36] = "home";
        KeyCodes2[KeyCodes2["insert"] = 45] = "insert";
        KeyCodes2[KeyCodes2["menu"] = 93] = "menu";
        KeyCodes2[KeyCodes2["minus"] = 189] = "minus";
        KeyCodes2[KeyCodes2["minus2"] = 109] = "minus2";
        KeyCodes2[KeyCodes2["numLock"] = 144] = "numLock";
        KeyCodes2[KeyCodes2["numPad0"] = 96] = "numPad0";
        KeyCodes2[KeyCodes2["numPad1"] = 97] = "numPad1";
        KeyCodes2[KeyCodes2["numPad2"] = 98] = "numPad2";
        KeyCodes2[KeyCodes2["numPad3"] = 99] = "numPad3";
        KeyCodes2[KeyCodes2["numPad4"] = 100] = "numPad4";
        KeyCodes2[KeyCodes2["numPad5"] = 101] = "numPad5";
        KeyCodes2[KeyCodes2["numPad6"] = 102] = "numPad6";
        KeyCodes2[KeyCodes2["numPad7"] = 103] = "numPad7";
        KeyCodes2[KeyCodes2["numPad8"] = 104] = "numPad8";
        KeyCodes2[KeyCodes2["numPad9"] = 105] = "numPad9";
        KeyCodes2[KeyCodes2["numPadDivide"] = 111] = "numPadDivide";
        KeyCodes2[KeyCodes2["numPadDot"] = 110] = "numPadDot";
        KeyCodes2[KeyCodes2["numPadMinus"] = 109] = "numPadMinus";
        KeyCodes2[KeyCodes2["numPadMultiply"] = 106] = "numPadMultiply";
        KeyCodes2[KeyCodes2["numPadPlus"] = 107] = "numPadPlus";
        KeyCodes2[KeyCodes2["openBracket"] = 219] = "openBracket";
        KeyCodes2[KeyCodes2["pageDown"] = 34] = "pageDown";
        KeyCodes2[KeyCodes2["pageUp"] = 33] = "pageUp";
        KeyCodes2[KeyCodes2["period"] = 190] = "period";
        KeyCodes2[KeyCodes2["print"] = 44] = "print";
        KeyCodes2[KeyCodes2["quote"] = 222] = "quote";
        KeyCodes2[KeyCodes2["scrollLock"] = 145] = "scrollLock";
        KeyCodes2[KeyCodes2["shift"] = 16] = "shift";
        KeyCodes2[KeyCodes2["space"] = 32] = "space";
        KeyCodes2[KeyCodes2["tab"] = 9] = "tab";
        KeyCodes2[KeyCodes2["tilde"] = 192] = "tilde";
        KeyCodes2[KeyCodes2["windowsLeft"] = 91] = "windowsLeft";
        KeyCodes2[KeyCodes2["windowsOpera"] = 219] = "windowsOpera";
        KeyCodes2[KeyCodes2["windowsRight"] = 92] = "windowsRight";
      })(KeyCodes || (KeyCodes = {}));
      keyArrowDown = "ArrowDown";
      keyArrowLeft = "ArrowLeft";
      keyArrowRight = "ArrowRight";
      keyArrowUp = "ArrowUp";
      keyEnter = "Enter";
      keyEscape = "Escape";
      keyHome = "Home";
      keyEnd = "End";
      keyFunction2 = "F2";
      keyPageDown = "PageDown";
      keyPageUp = "PageUp";
      keySpace = " ";
      keyTab = "Tab";
      keyBackspace = "Backspace";
      keyDelete = "Delete";
      ArrowKeys = {
        ArrowDown: keyArrowDown,
        ArrowLeft: keyArrowLeft,
        ArrowRight: keyArrowRight,
        ArrowUp: keyArrowUp
      };
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/localization.js
  var Direction;
  var init_localization = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/localization.js"() {
      (function(Direction2) {
        Direction2["ltr"] = "ltr";
        Direction2["rtl"] = "rtl";
      })(Direction || (Direction = {}));
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/numbers.js
  function wrapInBounds(min, max, value) {
    if (value < min) {
      return max;
    } else if (value > max) {
      return min;
    }
    return value;
  }
  function limit(min, max, value) {
    return Math.min(Math.max(value, min), max);
  }
  function inRange(value, min, max = 0) {
    [min, max] = [min, max].sort((a, b) => a - b);
    return min <= value && value < max;
  }
  var init_numbers = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/numbers.js"() {
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/strings.js
  function uniqueId(prefix = "") {
    return `${prefix}${uniqueIdCounter++}`;
  }
  var uniqueIdCounter;
  var init_strings = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/strings.js"() {
      uniqueIdCounter = 0;
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/query.js
  var init_query = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/query.js"() {
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/rtl-scroll-converter.js
  var RtlScrollConverter;
  var init_rtl_scroll_converter = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/rtl-scroll-converter.js"() {
      init_dist();
      init_localization();
      RtlScrollConverter = class _RtlScrollConverter {
        /**
         *  Gets the scrollLeft value of the provided element
         */
        static getScrollLeft(scrolledElement, direction) {
          if (direction === Direction.rtl) {
            return _RtlScrollConverter.getRtlScrollLeftConverter(scrolledElement);
          }
          return scrolledElement.scrollLeft;
        }
        /**
         * Sets the scrollLeft value of the provided element
         */
        static setScrollLeft(scrolledElement, scrollValue, direction) {
          if (direction === Direction.rtl) {
            _RtlScrollConverter.setRtlScrollLeftConverter(scrolledElement, scrollValue);
            return;
          }
          scrolledElement.scrollLeft = scrollValue;
        }
        /**
         * The initial rtl scroll converter getter function, it calls the browser test to set the correct converter
         * functions and then invokes the getter
         */
        static initialGetRtlScrollConverter(scrolledElement) {
          _RtlScrollConverter.initializeRtlScrollConverters();
          return _RtlScrollConverter.getRtlScrollLeftConverter(scrolledElement);
        }
        /**
         * The "direct" rtl get scroll converter does not need to tamper with the scrollLeft
         * values as the browser is already doing the right thing.  Content start = 0 and
         * scrolling left goes negative.
         */
        static directGetRtlScrollConverter(scrolledElement) {
          return scrolledElement.scrollLeft;
        }
        /**
         * The "inverted" get scroll converter is used when the browser reports scroll left
         * as a positive maximum scroll value at content start and then goes to zero as content
         * is scrolled left
         */
        static invertedGetRtlScrollConverter(scrolledElement) {
          return -Math.abs(scrolledElement.scrollLeft);
        }
        /**
         * The "reverse" get scroll converter is used when the browser reports scroll left
         * as 0 at content start and then goes positive as content is scrolled left
         */
        static reverseGetRtlScrollConverter(scrolledElement) {
          return scrolledElement.scrollLeft - (scrolledElement.scrollWidth - scrolledElement.clientWidth);
        }
        /**
         * The initial rtl scroll converter setter function, it calls the browser test to set the correct converter
         * functions and then invokes the setter
         */
        static initialSetRtlScrollConverter(scrolledElement, newScrollValue) {
          _RtlScrollConverter.initializeRtlScrollConverters();
          _RtlScrollConverter.setRtlScrollLeftConverter(scrolledElement, newScrollValue);
        }
        /**
         * The "direct" rtl set scroll converter does not need to tamper with the scrollLeft
         * values as the browser is already doing the right thing.  Content start = 0 and
         * scrolling left goes negative.
         */
        static directSetRtlScrollConverter(scrolledElement, newScrollValue) {
          scrolledElement.scrollLeft = newScrollValue;
        }
        /**
         * The "inverted" set scroll converter is used when the browser reports scroll left
         * as a positive maximum scroll value at content start and then goes to zero as content
         * is scrolled left
         */
        static invertedSetRtlScrollConverter(scrolledElement, newScrollValue) {
          scrolledElement.scrollLeft = Math.abs(newScrollValue);
        }
        /**
         * The "reverse" set scroll converter is used when the browser reports scroll left
         * as 0 at content start and then goes positive as content is scrolled left
         */
        static reverseSetRtlScrollConverter(scrolledElement, newScrollValue) {
          const maxScroll = scrolledElement.scrollWidth - scrolledElement.clientWidth;
          scrolledElement.scrollLeft = maxScroll + newScrollValue;
        }
        /**
         * detects the appropriate rtl scroll converter functions and assigns them
         * should only run once
         */
        static initializeRtlScrollConverters() {
          if (!canUseDOM()) {
            _RtlScrollConverter.applyDirectScrollConverters();
            return;
          }
          const testElement = _RtlScrollConverter.getTestElement();
          document.body.appendChild(testElement);
          _RtlScrollConverter.checkForScrollType(testElement);
          document.body.removeChild(testElement);
        }
        /**
         * checks the provided test element to determine scroll type
         * and apply appropriate converters
         */
        static checkForScrollType(testElement) {
          if (_RtlScrollConverter.isReverse(testElement)) {
            _RtlScrollConverter.applyReverseScrollConverters();
          } else {
            if (_RtlScrollConverter.isDirect(testElement)) {
              _RtlScrollConverter.applyDirectScrollConverters();
            } else {
              _RtlScrollConverter.applyInvertedScrollConverters();
            }
          }
        }
        /**
         * checks test element initial state for rtl "reverse" mode
         */
        static isReverse(testElement) {
          return testElement.scrollLeft > 0;
        }
        /**
         * checks test element for rtl "direct" mode
         */
        static isDirect(testElement) {
          testElement.scrollLeft = -1;
          return testElement.scrollLeft < 0;
        }
        /**
         * apply direct scroll conververters
         */
        static applyDirectScrollConverters() {
          _RtlScrollConverter.setRtlScrollLeftConverter = _RtlScrollConverter.directSetRtlScrollConverter;
          _RtlScrollConverter.getRtlScrollLeftConverter = _RtlScrollConverter.directGetRtlScrollConverter;
        }
        /**
         * apply inverted scroll conververters
         */
        static applyInvertedScrollConverters() {
          _RtlScrollConverter.setRtlScrollLeftConverter = _RtlScrollConverter.invertedSetRtlScrollConverter;
          _RtlScrollConverter.getRtlScrollLeftConverter = _RtlScrollConverter.invertedGetRtlScrollConverter;
        }
        /**
         * apply reverse scroll conververters
         */
        static applyReverseScrollConverters() {
          _RtlScrollConverter.setRtlScrollLeftConverter = _RtlScrollConverter.reverseSetRtlScrollConverter;
          _RtlScrollConverter.getRtlScrollLeftConverter = _RtlScrollConverter.reverseGetRtlScrollConverter;
        }
        /**
         * generate a test element for rtl testing
         */
        static getTestElement() {
          const testElement = document.createElement("div");
          testElement.appendChild(document.createTextNode("ABCD"));
          testElement.dir = "rtl";
          testElement.style.fontSize = "14px";
          testElement.style.width = "4px";
          testElement.style.height = "1px";
          testElement.style.position = "absolute";
          testElement.style.top = "-1000px";
          testElement.style.overflow = "scroll";
          return testElement;
        }
      };
      RtlScrollConverter.getRtlScrollLeftConverter = RtlScrollConverter.initialGetRtlScrollConverter;
      RtlScrollConverter.setRtlScrollLeftConverter = RtlScrollConverter.initialSetRtlScrollConverter;
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/system-colors.js
  var SystemColors;
  var init_system_colors = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/system-colors.js"() {
      (function(SystemColors2) {
        SystemColors2["Canvas"] = "Canvas";
        SystemColors2["CanvasText"] = "CanvasText";
        SystemColors2["LinkText"] = "LinkText";
        SystemColors2["VisitedText"] = "VisitedText";
        SystemColors2["ActiveText"] = "ActiveText";
        SystemColors2["ButtonFace"] = "ButtonFace";
        SystemColors2["ButtonText"] = "ButtonText";
        SystemColors2["Field"] = "Field";
        SystemColors2["FieldText"] = "FieldText";
        SystemColors2["Highlight"] = "Highlight";
        SystemColors2["HighlightText"] = "HighlightText";
        SystemColors2["GrayText"] = "GrayText";
      })(SystemColors || (SystemColors = {}));
    }
  });

  // node_modules/@microsoft/fast-web-utilities/dist/index.js
  var init_dist2 = __esm({
    "node_modules/@microsoft/fast-web-utilities/dist/index.js"() {
      init_aria();
      init_array();
      init_class_names();
      init_dom2();
      init_events();
      init_html();
      init_key_codes();
      init_localization();
      init_numbers();
      init_strings();
      init_query();
      init_rtl_scroll_converter();
      init_system_colors();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/accordion/accordion.js
  var AccordionExpandMode, Accordion;
  var init_accordion = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/accordion/accordion.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_foundation_element();
      init_accordion_item();
      AccordionExpandMode = {
        /**
         * Designates only a single {@link @microsoft/fast-foundation#(AccordionItem:class) } can be open a time.
         */
        single: "single",
        /**
         * Designates multiple {@link @microsoft/fast-foundation#(AccordionItem:class) | AccordionItems} can be open simultaneously.
         */
        multi: "multi"
      };
      Accordion = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.expandmode = AccordionExpandMode.multi;
          this.activeItemIndex = 0;
          this.change = () => {
            this.$emit("change", this.activeid);
          };
          this.setItems = () => {
            var _a;
            if (this.accordionItems.length === 0) {
              return;
            }
            this.accordionIds = this.getItemIds();
            this.accordionItems.forEach((item, index) => {
              if (item instanceof AccordionItem) {
                item.addEventListener("change", this.activeItemChange);
                if (this.isSingleExpandMode()) {
                  this.activeItemIndex !== index ? item.expanded = false : item.expanded = true;
                }
              }
              const itemId = this.accordionIds[index];
              item.setAttribute("id", typeof itemId !== "string" ? `accordion-${index + 1}` : itemId);
              this.activeid = this.accordionIds[this.activeItemIndex];
              item.addEventListener("keydown", this.handleItemKeyDown);
              item.addEventListener("focus", this.handleItemFocus);
            });
            if (this.isSingleExpandMode()) {
              const expandedItem = (_a = this.findExpandedItem()) !== null && _a !== void 0 ? _a : this.accordionItems[0];
              expandedItem.setAttribute("aria-disabled", "true");
            }
          };
          this.removeItemListeners = (oldValue) => {
            oldValue.forEach((item, index) => {
              item.removeEventListener("change", this.activeItemChange);
              item.removeEventListener("keydown", this.handleItemKeyDown);
              item.removeEventListener("focus", this.handleItemFocus);
            });
          };
          this.activeItemChange = (event) => {
            if (event.defaultPrevented || event.target !== event.currentTarget) {
              return;
            }
            event.preventDefault();
            const selectedItem = event.target;
            this.activeid = selectedItem.getAttribute("id");
            if (this.isSingleExpandMode()) {
              this.resetItems();
              selectedItem.expanded = true;
              selectedItem.setAttribute("aria-disabled", "true");
              this.accordionItems.forEach((item) => {
                if (!item.hasAttribute("disabled") && item.id !== this.activeid) {
                  item.removeAttribute("aria-disabled");
                }
              });
            }
            this.activeItemIndex = Array.from(this.accordionItems).indexOf(selectedItem);
            this.change();
          };
          this.handleItemKeyDown = (event) => {
            if (event.target !== event.currentTarget) {
              return;
            }
            this.accordionIds = this.getItemIds();
            switch (event.key) {
              case keyArrowUp:
                event.preventDefault();
                this.adjust(-1);
                break;
              case keyArrowDown:
                event.preventDefault();
                this.adjust(1);
                break;
              case keyHome:
                this.activeItemIndex = 0;
                this.focusItem();
                break;
              case keyEnd:
                this.activeItemIndex = this.accordionItems.length - 1;
                this.focusItem();
                break;
            }
          };
          this.handleItemFocus = (event) => {
            if (event.target === event.currentTarget) {
              const focusedItem = event.target;
              const focusedIndex = this.activeItemIndex = Array.from(this.accordionItems).indexOf(focusedItem);
              if (this.activeItemIndex !== focusedIndex && focusedIndex !== -1) {
                this.activeItemIndex = focusedIndex;
                this.activeid = this.accordionIds[this.activeItemIndex];
              }
            }
          };
        }
        /**
         * @internal
         */
        accordionItemsChanged(oldValue, newValue) {
          if (this.$fastController.isConnected) {
            this.removeItemListeners(oldValue);
            this.setItems();
          }
        }
        findExpandedItem() {
          for (let item = 0; item < this.accordionItems.length; item++) {
            if (this.accordionItems[item].getAttribute("expanded") === "true") {
              return this.accordionItems[item];
            }
          }
          return null;
        }
        resetItems() {
          this.accordionItems.forEach((item, index) => {
            item.expanded = false;
          });
        }
        getItemIds() {
          return this.accordionItems.map((accordionItem) => {
            return accordionItem.getAttribute("id");
          });
        }
        isSingleExpandMode() {
          return this.expandmode === AccordionExpandMode.single;
        }
        adjust(adjustment) {
          this.activeItemIndex = wrapInBounds(0, this.accordionItems.length - 1, this.activeItemIndex + adjustment);
          this.focusItem();
        }
        focusItem() {
          const element = this.accordionItems[this.activeItemIndex];
          if (element instanceof AccordionItem) {
            element.expandbutton.focus();
          }
        }
      };
      __decorate([
        attr({ attribute: "expand-mode" })
      ], Accordion.prototype, "expandmode", void 0);
      __decorate([
        observable
      ], Accordion.prototype, "accordionItems", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/accordion/index.js
  var init_accordion2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/accordion/index.js"() {
      init_accordion_template();
      init_accordion();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/anchor/anchor.template.js
  var anchorTemplate;
  var init_anchor_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/anchor/anchor.template.js"() {
      init_esm();
      init_start_end();
      anchorTemplate = (context, definition) => html`
    <a
        class="control"
        part="control"
        download="${(x) => x.download}"
        href="${(x) => x.href}"
        hreflang="${(x) => x.hreflang}"
        ping="${(x) => x.ping}"
        referrerpolicy="${(x) => x.referrerpolicy}"
        rel="${(x) => x.rel}"
        target="${(x) => x.target}"
        type="${(x) => x.type}"
        aria-atomic="${(x) => x.ariaAtomic}"
        aria-busy="${(x) => x.ariaBusy}"
        aria-controls="${(x) => x.ariaControls}"
        aria-current="${(x) => x.ariaCurrent}"
        aria-describedby="${(x) => x.ariaDescribedby}"
        aria-details="${(x) => x.ariaDetails}"
        aria-disabled="${(x) => x.ariaDisabled}"
        aria-errormessage="${(x) => x.ariaErrormessage}"
        aria-expanded="${(x) => x.ariaExpanded}"
        aria-flowto="${(x) => x.ariaFlowto}"
        aria-haspopup="${(x) => x.ariaHaspopup}"
        aria-hidden="${(x) => x.ariaHidden}"
        aria-invalid="${(x) => x.ariaInvalid}"
        aria-keyshortcuts="${(x) => x.ariaKeyshortcuts}"
        aria-label="${(x) => x.ariaLabel}"
        aria-labelledby="${(x) => x.ariaLabelledby}"
        aria-live="${(x) => x.ariaLive}"
        aria-owns="${(x) => x.ariaOwns}"
        aria-relevant="${(x) => x.ariaRelevant}"
        aria-roledescription="${(x) => x.ariaRoledescription}"
        ${ref("control")}
    >
        ${startSlotTemplate(context, definition)}
        <span class="content" part="content">
            <slot ${slotted("defaultSlottedContent")}></slot>
        </span>
        ${endSlotTemplate(context, definition)}
    </a>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/patterns/aria-global.js
  var ARIAGlobalStatesAndProperties;
  var init_aria_global = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/patterns/aria-global.js"() {
      init_tslib_es6();
      init_esm();
      ARIAGlobalStatesAndProperties = class {
      };
      __decorate([
        attr({ attribute: "aria-atomic" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaAtomic", void 0);
      __decorate([
        attr({ attribute: "aria-busy" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaBusy", void 0);
      __decorate([
        attr({ attribute: "aria-controls" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaControls", void 0);
      __decorate([
        attr({ attribute: "aria-current" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaCurrent", void 0);
      __decorate([
        attr({ attribute: "aria-describedby" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaDescribedby", void 0);
      __decorate([
        attr({ attribute: "aria-details" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaDetails", void 0);
      __decorate([
        attr({ attribute: "aria-disabled" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaDisabled", void 0);
      __decorate([
        attr({ attribute: "aria-errormessage" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaErrormessage", void 0);
      __decorate([
        attr({ attribute: "aria-flowto" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaFlowto", void 0);
      __decorate([
        attr({ attribute: "aria-haspopup" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaHaspopup", void 0);
      __decorate([
        attr({ attribute: "aria-hidden" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaHidden", void 0);
      __decorate([
        attr({ attribute: "aria-invalid" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaInvalid", void 0);
      __decorate([
        attr({ attribute: "aria-keyshortcuts" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaKeyshortcuts", void 0);
      __decorate([
        attr({ attribute: "aria-label" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaLabel", void 0);
      __decorate([
        attr({ attribute: "aria-labelledby" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaLabelledby", void 0);
      __decorate([
        attr({ attribute: "aria-live" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaLive", void 0);
      __decorate([
        attr({ attribute: "aria-owns" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaOwns", void 0);
      __decorate([
        attr({ attribute: "aria-relevant" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaRelevant", void 0);
      __decorate([
        attr({ attribute: "aria-roledescription" })
      ], ARIAGlobalStatesAndProperties.prototype, "ariaRoledescription", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/patterns/index.js
  var init_patterns = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/patterns/index.js"() {
      init_aria_global();
      init_start_end();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/anchor/anchor.js
  var Anchor, DelegatesARIALink;
  var init_anchor = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/anchor/anchor.js"() {
      init_tslib_es6();
      init_esm();
      init_foundation_element();
      init_patterns();
      init_apply_mixins();
      Anchor = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.handleUnsupportedDelegatesFocus = () => {
            var _a;
            if (window.ShadowRoot && !window.ShadowRoot.prototype.hasOwnProperty("delegatesFocus") && ((_a = this.$fastController.definition.shadowOptions) === null || _a === void 0 ? void 0 : _a.delegatesFocus)) {
              this.focus = () => {
                var _a2;
                (_a2 = this.control) === null || _a2 === void 0 ? void 0 : _a2.focus();
              };
            }
          };
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.handleUnsupportedDelegatesFocus();
        }
      };
      __decorate([
        attr
      ], Anchor.prototype, "download", void 0);
      __decorate([
        attr
      ], Anchor.prototype, "href", void 0);
      __decorate([
        attr
      ], Anchor.prototype, "hreflang", void 0);
      __decorate([
        attr
      ], Anchor.prototype, "ping", void 0);
      __decorate([
        attr
      ], Anchor.prototype, "referrerpolicy", void 0);
      __decorate([
        attr
      ], Anchor.prototype, "rel", void 0);
      __decorate([
        attr
      ], Anchor.prototype, "target", void 0);
      __decorate([
        attr
      ], Anchor.prototype, "type", void 0);
      __decorate([
        observable
      ], Anchor.prototype, "defaultSlottedContent", void 0);
      DelegatesARIALink = class {
      };
      __decorate([
        attr({ attribute: "aria-expanded" })
      ], DelegatesARIALink.prototype, "ariaExpanded", void 0);
      applyMixins(DelegatesARIALink, ARIAGlobalStatesAndProperties);
      applyMixins(Anchor, StartEnd, DelegatesARIALink);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/anchor/index.js
  var init_anchor2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/anchor/index.js"() {
      init_anchor_template();
      init_anchor();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/anchored-region/anchored-region.template.js
  var init_anchored_region_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/anchored-region/anchored-region.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/direction.js
  var getDirection;
  var init_direction = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/direction.js"() {
      init_dist2();
      getDirection = (rootNode) => {
        const dirNode = rootNode.closest("[dir]");
        return dirNode !== null && dirNode.dir === "rtl" ? Direction.rtl : Direction.ltr;
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/intersection-service.js
  var IntersectionService;
  var init_intersection_service = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/intersection-service.js"() {
      init_esm();
      IntersectionService = class {
        constructor() {
          this.intersectionDetector = null;
          this.observedElements = /* @__PURE__ */ new Map();
          this.requestPosition = (target, callback) => {
            var _a;
            if (this.intersectionDetector === null) {
              return;
            }
            if (this.observedElements.has(target)) {
              (_a = this.observedElements.get(target)) === null || _a === void 0 ? void 0 : _a.push(callback);
              return;
            }
            this.observedElements.set(target, [callback]);
            this.intersectionDetector.observe(target);
          };
          this.cancelRequestPosition = (target, callback) => {
            const callbacks = this.observedElements.get(target);
            if (callbacks !== void 0) {
              const callBackIndex = callbacks.indexOf(callback);
              if (callBackIndex !== -1) {
                callbacks.splice(callBackIndex, 1);
              }
            }
          };
          this.initializeIntersectionDetector = () => {
            if (!$global.IntersectionObserver) {
              return;
            }
            this.intersectionDetector = new IntersectionObserver(this.handleIntersection, {
              root: null,
              rootMargin: "0px",
              threshold: [0, 1]
            });
          };
          this.handleIntersection = (entries) => {
            if (this.intersectionDetector === null) {
              return;
            }
            const pendingCallbacks = [];
            const pendingCallbackParams = [];
            entries.forEach((entry) => {
              var _a;
              (_a = this.intersectionDetector) === null || _a === void 0 ? void 0 : _a.unobserve(entry.target);
              const thisElementCallbacks = this.observedElements.get(entry.target);
              if (thisElementCallbacks !== void 0) {
                thisElementCallbacks.forEach((callback) => {
                  let targetCallbackIndex = pendingCallbacks.indexOf(callback);
                  if (targetCallbackIndex === -1) {
                    targetCallbackIndex = pendingCallbacks.length;
                    pendingCallbacks.push(callback);
                    pendingCallbackParams.push([]);
                  }
                  pendingCallbackParams[targetCallbackIndex].push(entry);
                });
                this.observedElements.delete(entry.target);
              }
            });
            pendingCallbacks.forEach((callback, index) => {
              callback(pendingCallbackParams[index]);
            });
          };
          this.initializeIntersectionDetector();
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/anchored-region/anchored-region.js
  var AnchoredRegion;
  var init_anchored_region = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/anchored-region/anchored-region.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_foundation_element();
      init_direction();
      init_intersection_service();
      AnchoredRegion = class _AnchoredRegion extends FoundationElement {
        constructor() {
          super(...arguments);
          this.anchor = "";
          this.viewport = "";
          this.horizontalPositioningMode = "uncontrolled";
          this.horizontalDefaultPosition = "unset";
          this.horizontalViewportLock = false;
          this.horizontalInset = false;
          this.horizontalScaling = "content";
          this.verticalPositioningMode = "uncontrolled";
          this.verticalDefaultPosition = "unset";
          this.verticalViewportLock = false;
          this.verticalInset = false;
          this.verticalScaling = "content";
          this.fixedPlacement = false;
          this.autoUpdateMode = "anchor";
          this.anchorElement = null;
          this.viewportElement = null;
          this.initialLayoutComplete = false;
          this.resizeDetector = null;
          this.baseHorizontalOffset = 0;
          this.baseVerticalOffset = 0;
          this.pendingPositioningUpdate = false;
          this.pendingReset = false;
          this.currentDirection = Direction.ltr;
          this.regionVisible = false;
          this.forceUpdate = false;
          this.updateThreshold = 0.5;
          this.update = () => {
            if (!this.pendingPositioningUpdate) {
              this.requestPositionUpdates();
            }
          };
          this.startObservers = () => {
            this.stopObservers();
            if (this.anchorElement === null) {
              return;
            }
            this.requestPositionUpdates();
            if (this.resizeDetector !== null) {
              this.resizeDetector.observe(this.anchorElement);
              this.resizeDetector.observe(this);
            }
          };
          this.requestPositionUpdates = () => {
            if (this.anchorElement === null || this.pendingPositioningUpdate) {
              return;
            }
            _AnchoredRegion.intersectionService.requestPosition(this, this.handleIntersection);
            _AnchoredRegion.intersectionService.requestPosition(this.anchorElement, this.handleIntersection);
            if (this.viewportElement !== null) {
              _AnchoredRegion.intersectionService.requestPosition(this.viewportElement, this.handleIntersection);
            }
            this.pendingPositioningUpdate = true;
          };
          this.stopObservers = () => {
            if (this.pendingPositioningUpdate) {
              this.pendingPositioningUpdate = false;
              _AnchoredRegion.intersectionService.cancelRequestPosition(this, this.handleIntersection);
              if (this.anchorElement !== null) {
                _AnchoredRegion.intersectionService.cancelRequestPosition(this.anchorElement, this.handleIntersection);
              }
              if (this.viewportElement !== null) {
                _AnchoredRegion.intersectionService.cancelRequestPosition(this.viewportElement, this.handleIntersection);
              }
            }
            if (this.resizeDetector !== null) {
              this.resizeDetector.disconnect();
            }
          };
          this.getViewport = () => {
            if (typeof this.viewport !== "string" || this.viewport === "") {
              return document.documentElement;
            }
            return document.getElementById(this.viewport);
          };
          this.getAnchor = () => {
            return document.getElementById(this.anchor);
          };
          this.handleIntersection = (entries) => {
            if (!this.pendingPositioningUpdate) {
              return;
            }
            this.pendingPositioningUpdate = false;
            if (!this.applyIntersectionEntries(entries)) {
              return;
            }
            this.updateLayout();
          };
          this.applyIntersectionEntries = (entries) => {
            const regionEntry = entries.find((x) => x.target === this);
            const anchorEntry = entries.find((x) => x.target === this.anchorElement);
            const viewportEntry = entries.find((x) => x.target === this.viewportElement);
            if (regionEntry === void 0 || viewportEntry === void 0 || anchorEntry === void 0) {
              return false;
            }
            if (!this.regionVisible || this.forceUpdate || this.regionRect === void 0 || this.anchorRect === void 0 || this.viewportRect === void 0 || this.isRectDifferent(this.anchorRect, anchorEntry.boundingClientRect) || this.isRectDifferent(this.viewportRect, viewportEntry.boundingClientRect) || this.isRectDifferent(this.regionRect, regionEntry.boundingClientRect)) {
              this.regionRect = regionEntry.boundingClientRect;
              this.anchorRect = anchorEntry.boundingClientRect;
              if (this.viewportElement === document.documentElement) {
                this.viewportRect = new DOMRectReadOnly(viewportEntry.boundingClientRect.x + document.documentElement.scrollLeft, viewportEntry.boundingClientRect.y + document.documentElement.scrollTop, viewportEntry.boundingClientRect.width, viewportEntry.boundingClientRect.height);
              } else {
                this.viewportRect = viewportEntry.boundingClientRect;
              }
              this.updateRegionOffset();
              this.forceUpdate = false;
              return true;
            }
            return false;
          };
          this.updateRegionOffset = () => {
            if (this.anchorRect && this.regionRect) {
              this.baseHorizontalOffset = this.baseHorizontalOffset + (this.anchorRect.left - this.regionRect.left) + (this.translateX - this.baseHorizontalOffset);
              this.baseVerticalOffset = this.baseVerticalOffset + (this.anchorRect.top - this.regionRect.top) + (this.translateY - this.baseVerticalOffset);
            }
          };
          this.isRectDifferent = (rectA, rectB) => {
            if (Math.abs(rectA.top - rectB.top) > this.updateThreshold || Math.abs(rectA.right - rectB.right) > this.updateThreshold || Math.abs(rectA.bottom - rectB.bottom) > this.updateThreshold || Math.abs(rectA.left - rectB.left) > this.updateThreshold) {
              return true;
            }
            return false;
          };
          this.handleResize = (entries) => {
            this.update();
          };
          this.reset = () => {
            if (!this.pendingReset) {
              return;
            }
            this.pendingReset = false;
            if (this.anchorElement === null) {
              this.anchorElement = this.getAnchor();
            }
            if (this.viewportElement === null) {
              this.viewportElement = this.getViewport();
            }
            this.currentDirection = getDirection(this);
            this.startObservers();
          };
          this.updateLayout = () => {
            let desiredVerticalPosition = void 0;
            let desiredHorizontalPosition = void 0;
            if (this.horizontalPositioningMode !== "uncontrolled") {
              const horizontalOptions = this.getPositioningOptions(this.horizontalInset);
              if (this.horizontalDefaultPosition === "center") {
                desiredHorizontalPosition = "center";
              } else if (this.horizontalDefaultPosition !== "unset") {
                let dirCorrectedHorizontalDefaultPosition = this.horizontalDefaultPosition;
                if (dirCorrectedHorizontalDefaultPosition === "start" || dirCorrectedHorizontalDefaultPosition === "end") {
                  const newDirection = getDirection(this);
                  if (newDirection !== this.currentDirection) {
                    this.currentDirection = newDirection;
                    this.initialize();
                    return;
                  }
                  if (this.currentDirection === Direction.ltr) {
                    dirCorrectedHorizontalDefaultPosition = dirCorrectedHorizontalDefaultPosition === "start" ? "left" : "right";
                  } else {
                    dirCorrectedHorizontalDefaultPosition = dirCorrectedHorizontalDefaultPosition === "start" ? "right" : "left";
                  }
                }
                switch (dirCorrectedHorizontalDefaultPosition) {
                  case "left":
                    desiredHorizontalPosition = this.horizontalInset ? "insetStart" : "start";
                    break;
                  case "right":
                    desiredHorizontalPosition = this.horizontalInset ? "insetEnd" : "end";
                    break;
                }
              }
              const horizontalThreshold = this.horizontalThreshold !== void 0 ? this.horizontalThreshold : this.regionRect !== void 0 ? this.regionRect.width : 0;
              const anchorLeft = this.anchorRect !== void 0 ? this.anchorRect.left : 0;
              const anchorRight = this.anchorRect !== void 0 ? this.anchorRect.right : 0;
              const anchorWidth = this.anchorRect !== void 0 ? this.anchorRect.width : 0;
              const viewportLeft = this.viewportRect !== void 0 ? this.viewportRect.left : 0;
              const viewportRight = this.viewportRect !== void 0 ? this.viewportRect.right : 0;
              if (desiredHorizontalPosition === void 0 || !(this.horizontalPositioningMode === "locktodefault") && this.getAvailableSpace(desiredHorizontalPosition, anchorLeft, anchorRight, anchorWidth, viewportLeft, viewportRight) < horizontalThreshold) {
                desiredHorizontalPosition = this.getAvailableSpace(horizontalOptions[0], anchorLeft, anchorRight, anchorWidth, viewportLeft, viewportRight) > this.getAvailableSpace(horizontalOptions[1], anchorLeft, anchorRight, anchorWidth, viewportLeft, viewportRight) ? horizontalOptions[0] : horizontalOptions[1];
              }
            }
            if (this.verticalPositioningMode !== "uncontrolled") {
              const verticalOptions = this.getPositioningOptions(this.verticalInset);
              if (this.verticalDefaultPosition === "center") {
                desiredVerticalPosition = "center";
              } else if (this.verticalDefaultPosition !== "unset") {
                switch (this.verticalDefaultPosition) {
                  case "top":
                    desiredVerticalPosition = this.verticalInset ? "insetStart" : "start";
                    break;
                  case "bottom":
                    desiredVerticalPosition = this.verticalInset ? "insetEnd" : "end";
                    break;
                }
              }
              const verticalThreshold = this.verticalThreshold !== void 0 ? this.verticalThreshold : this.regionRect !== void 0 ? this.regionRect.height : 0;
              const anchorTop = this.anchorRect !== void 0 ? this.anchorRect.top : 0;
              const anchorBottom = this.anchorRect !== void 0 ? this.anchorRect.bottom : 0;
              const anchorHeight = this.anchorRect !== void 0 ? this.anchorRect.height : 0;
              const viewportTop = this.viewportRect !== void 0 ? this.viewportRect.top : 0;
              const viewportBottom = this.viewportRect !== void 0 ? this.viewportRect.bottom : 0;
              if (desiredVerticalPosition === void 0 || !(this.verticalPositioningMode === "locktodefault") && this.getAvailableSpace(desiredVerticalPosition, anchorTop, anchorBottom, anchorHeight, viewportTop, viewportBottom) < verticalThreshold) {
                desiredVerticalPosition = this.getAvailableSpace(verticalOptions[0], anchorTop, anchorBottom, anchorHeight, viewportTop, viewportBottom) > this.getAvailableSpace(verticalOptions[1], anchorTop, anchorBottom, anchorHeight, viewportTop, viewportBottom) ? verticalOptions[0] : verticalOptions[1];
              }
            }
            const nextPositionerDimension = this.getNextRegionDimension(desiredHorizontalPosition, desiredVerticalPosition);
            const positionChanged = this.horizontalPosition !== desiredHorizontalPosition || this.verticalPosition !== desiredVerticalPosition;
            this.setHorizontalPosition(desiredHorizontalPosition, nextPositionerDimension);
            this.setVerticalPosition(desiredVerticalPosition, nextPositionerDimension);
            this.updateRegionStyle();
            if (!this.initialLayoutComplete) {
              this.initialLayoutComplete = true;
              this.requestPositionUpdates();
              return;
            }
            if (!this.regionVisible) {
              this.regionVisible = true;
              this.style.removeProperty("pointer-events");
              this.style.removeProperty("opacity");
              this.classList.toggle("loaded", true);
              this.$emit("loaded", this, { bubbles: false });
            }
            this.updatePositionClasses();
            if (positionChanged) {
              this.$emit("positionchange", this, { bubbles: false });
            }
          };
          this.updateRegionStyle = () => {
            this.style.width = this.regionWidth;
            this.style.height = this.regionHeight;
            this.style.transform = `translate(${this.translateX}px, ${this.translateY}px)`;
          };
          this.updatePositionClasses = () => {
            this.classList.toggle("top", this.verticalPosition === "start");
            this.classList.toggle("bottom", this.verticalPosition === "end");
            this.classList.toggle("inset-top", this.verticalPosition === "insetStart");
            this.classList.toggle("inset-bottom", this.verticalPosition === "insetEnd");
            this.classList.toggle("vertical-center", this.verticalPosition === "center");
            this.classList.toggle("left", this.horizontalPosition === "start");
            this.classList.toggle("right", this.horizontalPosition === "end");
            this.classList.toggle("inset-left", this.horizontalPosition === "insetStart");
            this.classList.toggle("inset-right", this.horizontalPosition === "insetEnd");
            this.classList.toggle("horizontal-center", this.horizontalPosition === "center");
          };
          this.setHorizontalPosition = (desiredHorizontalPosition, nextPositionerDimension) => {
            if (desiredHorizontalPosition === void 0 || this.regionRect === void 0 || this.anchorRect === void 0 || this.viewportRect === void 0) {
              return;
            }
            let nextRegionWidth = 0;
            switch (this.horizontalScaling) {
              case "anchor":
              case "fill":
                nextRegionWidth = this.horizontalViewportLock ? this.viewportRect.width : nextPositionerDimension.width;
                this.regionWidth = `${nextRegionWidth}px`;
                break;
              case "content":
                nextRegionWidth = this.regionRect.width;
                this.regionWidth = "unset";
                break;
            }
            let sizeDelta = 0;
            switch (desiredHorizontalPosition) {
              case "start":
                this.translateX = this.baseHorizontalOffset - nextRegionWidth;
                if (this.horizontalViewportLock && this.anchorRect.left > this.viewportRect.right) {
                  this.translateX = this.translateX - (this.anchorRect.left - this.viewportRect.right);
                }
                break;
              case "insetStart":
                this.translateX = this.baseHorizontalOffset - nextRegionWidth + this.anchorRect.width;
                if (this.horizontalViewportLock && this.anchorRect.right > this.viewportRect.right) {
                  this.translateX = this.translateX - (this.anchorRect.right - this.viewportRect.right);
                }
                break;
              case "insetEnd":
                this.translateX = this.baseHorizontalOffset;
                if (this.horizontalViewportLock && this.anchorRect.left < this.viewportRect.left) {
                  this.translateX = this.translateX - (this.anchorRect.left - this.viewportRect.left);
                }
                break;
              case "end":
                this.translateX = this.baseHorizontalOffset + this.anchorRect.width;
                if (this.horizontalViewportLock && this.anchorRect.right < this.viewportRect.left) {
                  this.translateX = this.translateX - (this.anchorRect.right - this.viewportRect.left);
                }
                break;
              case "center":
                sizeDelta = (this.anchorRect.width - nextRegionWidth) / 2;
                this.translateX = this.baseHorizontalOffset + sizeDelta;
                if (this.horizontalViewportLock) {
                  const regionLeft = this.anchorRect.left + sizeDelta;
                  const regionRight = this.anchorRect.right - sizeDelta;
                  if (regionLeft < this.viewportRect.left && !(regionRight > this.viewportRect.right)) {
                    this.translateX = this.translateX - (regionLeft - this.viewportRect.left);
                  } else if (regionRight > this.viewportRect.right && !(regionLeft < this.viewportRect.left)) {
                    this.translateX = this.translateX - (regionRight - this.viewportRect.right);
                  }
                }
                break;
            }
            this.horizontalPosition = desiredHorizontalPosition;
          };
          this.setVerticalPosition = (desiredVerticalPosition, nextPositionerDimension) => {
            if (desiredVerticalPosition === void 0 || this.regionRect === void 0 || this.anchorRect === void 0 || this.viewportRect === void 0) {
              return;
            }
            let nextRegionHeight = 0;
            switch (this.verticalScaling) {
              case "anchor":
              case "fill":
                nextRegionHeight = this.verticalViewportLock ? this.viewportRect.height : nextPositionerDimension.height;
                this.regionHeight = `${nextRegionHeight}px`;
                break;
              case "content":
                nextRegionHeight = this.regionRect.height;
                this.regionHeight = "unset";
                break;
            }
            let sizeDelta = 0;
            switch (desiredVerticalPosition) {
              case "start":
                this.translateY = this.baseVerticalOffset - nextRegionHeight;
                if (this.verticalViewportLock && this.anchorRect.top > this.viewportRect.bottom) {
                  this.translateY = this.translateY - (this.anchorRect.top - this.viewportRect.bottom);
                }
                break;
              case "insetStart":
                this.translateY = this.baseVerticalOffset - nextRegionHeight + this.anchorRect.height;
                if (this.verticalViewportLock && this.anchorRect.bottom > this.viewportRect.bottom) {
                  this.translateY = this.translateY - (this.anchorRect.bottom - this.viewportRect.bottom);
                }
                break;
              case "insetEnd":
                this.translateY = this.baseVerticalOffset;
                if (this.verticalViewportLock && this.anchorRect.top < this.viewportRect.top) {
                  this.translateY = this.translateY - (this.anchorRect.top - this.viewportRect.top);
                }
                break;
              case "end":
                this.translateY = this.baseVerticalOffset + this.anchorRect.height;
                if (this.verticalViewportLock && this.anchorRect.bottom < this.viewportRect.top) {
                  this.translateY = this.translateY - (this.anchorRect.bottom - this.viewportRect.top);
                }
                break;
              case "center":
                sizeDelta = (this.anchorRect.height - nextRegionHeight) / 2;
                this.translateY = this.baseVerticalOffset + sizeDelta;
                if (this.verticalViewportLock) {
                  const regionTop = this.anchorRect.top + sizeDelta;
                  const regionBottom = this.anchorRect.bottom - sizeDelta;
                  if (regionTop < this.viewportRect.top && !(regionBottom > this.viewportRect.bottom)) {
                    this.translateY = this.translateY - (regionTop - this.viewportRect.top);
                  } else if (regionBottom > this.viewportRect.bottom && !(regionTop < this.viewportRect.top)) {
                    this.translateY = this.translateY - (regionBottom - this.viewportRect.bottom);
                  }
                }
            }
            this.verticalPosition = desiredVerticalPosition;
          };
          this.getPositioningOptions = (inset) => {
            if (inset) {
              return ["insetStart", "insetEnd"];
            }
            return ["start", "end"];
          };
          this.getAvailableSpace = (positionOption, anchorStart, anchorEnd, anchorSpan, viewportStart, viewportEnd) => {
            const spaceStart = anchorStart - viewportStart;
            const spaceEnd = viewportEnd - (anchorStart + anchorSpan);
            switch (positionOption) {
              case "start":
                return spaceStart;
              case "insetStart":
                return spaceStart + anchorSpan;
              case "insetEnd":
                return spaceEnd + anchorSpan;
              case "end":
                return spaceEnd;
              case "center":
                return Math.min(spaceStart, spaceEnd) * 2 + anchorSpan;
            }
          };
          this.getNextRegionDimension = (desiredHorizontalPosition, desiredVerticalPosition) => {
            const newRegionDimension = {
              height: this.regionRect !== void 0 ? this.regionRect.height : 0,
              width: this.regionRect !== void 0 ? this.regionRect.width : 0
            };
            if (desiredHorizontalPosition !== void 0 && this.horizontalScaling === "fill") {
              newRegionDimension.width = this.getAvailableSpace(desiredHorizontalPosition, this.anchorRect !== void 0 ? this.anchorRect.left : 0, this.anchorRect !== void 0 ? this.anchorRect.right : 0, this.anchorRect !== void 0 ? this.anchorRect.width : 0, this.viewportRect !== void 0 ? this.viewportRect.left : 0, this.viewportRect !== void 0 ? this.viewportRect.right : 0);
            } else if (this.horizontalScaling === "anchor") {
              newRegionDimension.width = this.anchorRect !== void 0 ? this.anchorRect.width : 0;
            }
            if (desiredVerticalPosition !== void 0 && this.verticalScaling === "fill") {
              newRegionDimension.height = this.getAvailableSpace(desiredVerticalPosition, this.anchorRect !== void 0 ? this.anchorRect.top : 0, this.anchorRect !== void 0 ? this.anchorRect.bottom : 0, this.anchorRect !== void 0 ? this.anchorRect.height : 0, this.viewportRect !== void 0 ? this.viewportRect.top : 0, this.viewportRect !== void 0 ? this.viewportRect.bottom : 0);
            } else if (this.verticalScaling === "anchor") {
              newRegionDimension.height = this.anchorRect !== void 0 ? this.anchorRect.height : 0;
            }
            return newRegionDimension;
          };
          this.startAutoUpdateEventListeners = () => {
            window.addEventListener(eventResize, this.update, { passive: true });
            window.addEventListener(eventScroll, this.update, {
              passive: true,
              capture: true
            });
            if (this.resizeDetector !== null && this.viewportElement !== null) {
              this.resizeDetector.observe(this.viewportElement);
            }
          };
          this.stopAutoUpdateEventListeners = () => {
            window.removeEventListener(eventResize, this.update);
            window.removeEventListener(eventScroll, this.update);
            if (this.resizeDetector !== null && this.viewportElement !== null) {
              this.resizeDetector.unobserve(this.viewportElement);
            }
          };
        }
        anchorChanged() {
          if (this.initialLayoutComplete) {
            this.anchorElement = this.getAnchor();
          }
        }
        viewportChanged() {
          if (this.initialLayoutComplete) {
            this.viewportElement = this.getViewport();
          }
        }
        horizontalPositioningModeChanged() {
          this.requestReset();
        }
        horizontalDefaultPositionChanged() {
          this.updateForAttributeChange();
        }
        horizontalViewportLockChanged() {
          this.updateForAttributeChange();
        }
        horizontalInsetChanged() {
          this.updateForAttributeChange();
        }
        horizontalThresholdChanged() {
          this.updateForAttributeChange();
        }
        horizontalScalingChanged() {
          this.updateForAttributeChange();
        }
        verticalPositioningModeChanged() {
          this.requestReset();
        }
        verticalDefaultPositionChanged() {
          this.updateForAttributeChange();
        }
        verticalViewportLockChanged() {
          this.updateForAttributeChange();
        }
        verticalInsetChanged() {
          this.updateForAttributeChange();
        }
        verticalThresholdChanged() {
          this.updateForAttributeChange();
        }
        verticalScalingChanged() {
          this.updateForAttributeChange();
        }
        fixedPlacementChanged() {
          if (this.$fastController.isConnected && this.initialLayoutComplete) {
            this.initialize();
          }
        }
        autoUpdateModeChanged(prevMode, newMode) {
          if (this.$fastController.isConnected && this.initialLayoutComplete) {
            if (prevMode === "auto") {
              this.stopAutoUpdateEventListeners();
            }
            if (newMode === "auto") {
              this.startAutoUpdateEventListeners();
            }
          }
        }
        anchorElementChanged() {
          this.requestReset();
        }
        viewportElementChanged() {
          if (this.$fastController.isConnected && this.initialLayoutComplete) {
            this.initialize();
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.autoUpdateMode === "auto") {
            this.startAutoUpdateEventListeners();
          }
          this.initialize();
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          super.disconnectedCallback();
          if (this.autoUpdateMode === "auto") {
            this.stopAutoUpdateEventListeners();
          }
          this.stopObservers();
          this.disconnectResizeDetector();
        }
        /**
         * @internal
         */
        adoptedCallback() {
          this.initialize();
        }
        /**
         * destroys the instance's resize observer
         */
        disconnectResizeDetector() {
          if (this.resizeDetector !== null) {
            this.resizeDetector.disconnect();
            this.resizeDetector = null;
          }
        }
        /**
         * initializes the instance's resize observer
         */
        initializeResizeDetector() {
          this.disconnectResizeDetector();
          this.resizeDetector = new window.ResizeObserver(this.handleResize);
        }
        /**
         * react to attribute changes that don't require a reset
         */
        updateForAttributeChange() {
          if (this.$fastController.isConnected && this.initialLayoutComplete) {
            this.forceUpdate = true;
            this.update();
          }
        }
        /**
         * fully initializes the component
         */
        initialize() {
          this.initializeResizeDetector();
          if (this.anchorElement === null) {
            this.anchorElement = this.getAnchor();
          }
          this.requestReset();
        }
        /**
         * Request a reset if there are currently no open requests
         */
        requestReset() {
          if (this.$fastController.isConnected && this.pendingReset === false) {
            this.setInitialState();
            DOM.queueUpdate(() => this.reset());
            this.pendingReset = true;
          }
        }
        /**
         * sets the starting configuration for component internal values
         */
        setInitialState() {
          this.initialLayoutComplete = false;
          this.regionVisible = false;
          this.translateX = 0;
          this.translateY = 0;
          this.baseHorizontalOffset = 0;
          this.baseVerticalOffset = 0;
          this.viewportRect = void 0;
          this.regionRect = void 0;
          this.anchorRect = void 0;
          this.verticalPosition = void 0;
          this.horizontalPosition = void 0;
          this.style.opacity = "0";
          this.style.pointerEvents = "none";
          this.forceUpdate = false;
          this.style.position = this.fixedPlacement ? "fixed" : "absolute";
          this.updatePositionClasses();
          this.updateRegionStyle();
        }
      };
      AnchoredRegion.intersectionService = new IntersectionService();
      __decorate([
        attr
      ], AnchoredRegion.prototype, "anchor", void 0);
      __decorate([
        attr
      ], AnchoredRegion.prototype, "viewport", void 0);
      __decorate([
        attr({ attribute: "horizontal-positioning-mode" })
      ], AnchoredRegion.prototype, "horizontalPositioningMode", void 0);
      __decorate([
        attr({ attribute: "horizontal-default-position" })
      ], AnchoredRegion.prototype, "horizontalDefaultPosition", void 0);
      __decorate([
        attr({ attribute: "horizontal-viewport-lock", mode: "boolean" })
      ], AnchoredRegion.prototype, "horizontalViewportLock", void 0);
      __decorate([
        attr({ attribute: "horizontal-inset", mode: "boolean" })
      ], AnchoredRegion.prototype, "horizontalInset", void 0);
      __decorate([
        attr({ attribute: "horizontal-threshold" })
      ], AnchoredRegion.prototype, "horizontalThreshold", void 0);
      __decorate([
        attr({ attribute: "horizontal-scaling" })
      ], AnchoredRegion.prototype, "horizontalScaling", void 0);
      __decorate([
        attr({ attribute: "vertical-positioning-mode" })
      ], AnchoredRegion.prototype, "verticalPositioningMode", void 0);
      __decorate([
        attr({ attribute: "vertical-default-position" })
      ], AnchoredRegion.prototype, "verticalDefaultPosition", void 0);
      __decorate([
        attr({ attribute: "vertical-viewport-lock", mode: "boolean" })
      ], AnchoredRegion.prototype, "verticalViewportLock", void 0);
      __decorate([
        attr({ attribute: "vertical-inset", mode: "boolean" })
      ], AnchoredRegion.prototype, "verticalInset", void 0);
      __decorate([
        attr({ attribute: "vertical-threshold" })
      ], AnchoredRegion.prototype, "verticalThreshold", void 0);
      __decorate([
        attr({ attribute: "vertical-scaling" })
      ], AnchoredRegion.prototype, "verticalScaling", void 0);
      __decorate([
        attr({ attribute: "fixed-placement", mode: "boolean" })
      ], AnchoredRegion.prototype, "fixedPlacement", void 0);
      __decorate([
        attr({ attribute: "auto-update-mode" })
      ], AnchoredRegion.prototype, "autoUpdateMode", void 0);
      __decorate([
        observable
      ], AnchoredRegion.prototype, "anchorElement", void 0);
      __decorate([
        observable
      ], AnchoredRegion.prototype, "viewportElement", void 0);
      __decorate([
        observable
      ], AnchoredRegion.prototype, "initialLayoutComplete", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/anchored-region/anchored-region-config.js
  var horizontalAnchorOverlay, FlyoutPosTop, FlyoutPosBottom, FlyoutPosTallest, FlyoutPosTopFill, FlyoutPosBottomFill, FlyoutPosTallestFill;
  var init_anchored_region_config = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/anchored-region/anchored-region-config.js"() {
      horizontalAnchorOverlay = {
        horizontalDefaultPosition: "center",
        horizontalPositioningMode: "locktodefault",
        horizontalInset: false,
        horizontalScaling: "anchor"
      };
      FlyoutPosTop = Object.assign(Object.assign({}, horizontalAnchorOverlay), { verticalDefaultPosition: "top", verticalPositioningMode: "locktodefault", verticalInset: false, verticalScaling: "content" });
      FlyoutPosBottom = Object.assign(Object.assign({}, horizontalAnchorOverlay), { verticalDefaultPosition: "bottom", verticalPositioningMode: "locktodefault", verticalInset: false, verticalScaling: "content" });
      FlyoutPosTallest = Object.assign(Object.assign({}, horizontalAnchorOverlay), { verticalPositioningMode: "dynamic", verticalInset: false, verticalScaling: "content" });
      FlyoutPosTopFill = Object.assign(Object.assign({}, FlyoutPosTop), { verticalScaling: "fill" });
      FlyoutPosBottomFill = Object.assign(Object.assign({}, FlyoutPosBottom), { verticalScaling: "fill" });
      FlyoutPosTallestFill = Object.assign(Object.assign({}, FlyoutPosTallest), { verticalScaling: "fill" });
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/anchored-region/index.js
  var init_anchored_region2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/anchored-region/index.js"() {
      init_anchored_region_template();
      init_anchored_region();
      init_anchored_region_config();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/avatar/avatar.template.js
  var init_avatar_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/avatar/avatar.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/avatar/avatar.js
  var Avatar;
  var init_avatar = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/avatar/avatar.js"() {
      init_tslib_es6();
      init_esm();
      init_foundation_element();
      Avatar = class extends FoundationElement {
        /**
         * Internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (!this.shape) {
            this.shape = "circle";
          }
        }
      };
      __decorate([
        attr
      ], Avatar.prototype, "fill", void 0);
      __decorate([
        attr
      ], Avatar.prototype, "color", void 0);
      __decorate([
        attr
      ], Avatar.prototype, "link", void 0);
      __decorate([
        attr
      ], Avatar.prototype, "shape", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/avatar/index.js
  var init_avatar2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/avatar/index.js"() {
      init_avatar_template();
      init_avatar();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/badge/badge.template.js
  var badgeTemplate;
  var init_badge_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/badge/badge.template.js"() {
      init_esm();
      badgeTemplate = (context, definition) => html`
    <template class="${(x) => x.circular ? "circular" : ""}">
        <div class="control" part="control" style="${(x) => x.generateBadgeStyle()}">
            <slot></slot>
        </div>
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/badge/badge.js
  var Badge;
  var init_badge = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/badge/badge.js"() {
      init_tslib_es6();
      init_esm();
      init_foundation_element();
      Badge = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.generateBadgeStyle = () => {
            if (!this.fill && !this.color) {
              return;
            }
            const fill = `background-color: var(--badge-fill-${this.fill});`;
            const color = `color: var(--badge-color-${this.color});`;
            if (this.fill && !this.color) {
              return fill;
            } else if (this.color && !this.fill) {
              return color;
            } else {
              return `${color} ${fill}`;
            }
          };
        }
      };
      __decorate([
        attr({ attribute: "fill" })
      ], Badge.prototype, "fill", void 0);
      __decorate([
        attr({ attribute: "color" })
      ], Badge.prototype, "color", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], Badge.prototype, "circular", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/badge/index.js
  var init_badge2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/badge/index.js"() {
      init_badge_template();
      init_badge();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb-item/breadcrumb-item.template.js
  var init_breadcrumb_item_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb-item/breadcrumb-item.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb-item/breadcrumb-item.js
  var BreadcrumbItem;
  var init_breadcrumb_item = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb-item/breadcrumb-item.js"() {
      init_tslib_es6();
      init_esm();
      init_anchor();
      init_patterns();
      init_apply_mixins();
      BreadcrumbItem = class extends Anchor {
        constructor() {
          super(...arguments);
          this.separator = true;
        }
      };
      __decorate([
        observable
      ], BreadcrumbItem.prototype, "separator", void 0);
      applyMixins(BreadcrumbItem, StartEnd, DelegatesARIALink);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb-item/index.js
  var init_breadcrumb_item2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb-item/index.js"() {
      init_breadcrumb_item_template();
      init_breadcrumb_item();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb/breadcrumb.template.js
  var init_breadcrumb_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb/breadcrumb.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb/breadcrumb.js
  var Breadcrumb;
  var init_breadcrumb = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb/breadcrumb.js"() {
      init_tslib_es6();
      init_esm();
      init_breadcrumb_item();
      init_foundation_element();
      Breadcrumb = class extends FoundationElement {
        slottedBreadcrumbItemsChanged() {
          if (this.$fastController.isConnected) {
            if (this.slottedBreadcrumbItems === void 0 || this.slottedBreadcrumbItems.length === 0) {
              return;
            }
            const lastNode = this.slottedBreadcrumbItems[this.slottedBreadcrumbItems.length - 1];
            this.slottedBreadcrumbItems.forEach((item) => {
              const itemIsLastNode = item === lastNode;
              this.setItemSeparator(item, itemIsLastNode);
              this.setAriaCurrent(item, itemIsLastNode);
            });
          }
        }
        setItemSeparator(item, isLastNode) {
          if (item instanceof BreadcrumbItem) {
            item.separator = !isLastNode;
          }
        }
        /**
         * Finds href on childnodes in the light DOM or shadow DOM.
         * We look in the shadow DOM because we insert an anchor when breadcrumb-item has an href.
         */
        findChildWithHref(node) {
          var _a, _b;
          if (node.childElementCount > 0) {
            return node.querySelector("a[href]");
          } else if ((_a = node.shadowRoot) === null || _a === void 0 ? void 0 : _a.childElementCount) {
            return (_b = node.shadowRoot) === null || _b === void 0 ? void 0 : _b.querySelector("a[href]");
          } else
            return null;
        }
        /**
         *  Sets ARIA Current for the current node
         * If child node with an anchor tag and with href is found then set aria-current to correct value for the child node,
         * otherwise apply aria-current to the host element, with an href
         */
        setAriaCurrent(item, isLastNode) {
          const childNodeWithHref = this.findChildWithHref(item);
          if (childNodeWithHref === null && item.hasAttribute("href") && item instanceof BreadcrumbItem) {
            isLastNode ? item.setAttribute("aria-current", "page") : item.removeAttribute("aria-current");
          } else if (childNodeWithHref !== null) {
            isLastNode ? childNodeWithHref.setAttribute("aria-current", "page") : childNodeWithHref.removeAttribute("aria-current");
          }
        }
      };
      __decorate([
        observable
      ], Breadcrumb.prototype, "slottedBreadcrumbItems", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb/index.js
  var init_breadcrumb2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/breadcrumb/index.js"() {
      init_breadcrumb_template();
      init_breadcrumb();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/button/button.template.js
  var buttonTemplate;
  var init_button_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/button/button.template.js"() {
      init_esm();
      init_start_end();
      buttonTemplate = (context, definition) => html`
    <button
        class="control"
        part="control"
        ?autofocus="${(x) => x.autofocus}"
        ?disabled="${(x) => x.disabled}"
        form="${(x) => x.formId}"
        formaction="${(x) => x.formaction}"
        formenctype="${(x) => x.formenctype}"
        formmethod="${(x) => x.formmethod}"
        formnovalidate="${(x) => x.formnovalidate}"
        formtarget="${(x) => x.formtarget}"
        name="${(x) => x.name}"
        type="${(x) => x.type}"
        value="${(x) => x.value}"
        aria-atomic="${(x) => x.ariaAtomic}"
        aria-busy="${(x) => x.ariaBusy}"
        aria-controls="${(x) => x.ariaControls}"
        aria-current="${(x) => x.ariaCurrent}"
        aria-describedby="${(x) => x.ariaDescribedby}"
        aria-details="${(x) => x.ariaDetails}"
        aria-disabled="${(x) => x.ariaDisabled}"
        aria-errormessage="${(x) => x.ariaErrormessage}"
        aria-expanded="${(x) => x.ariaExpanded}"
        aria-flowto="${(x) => x.ariaFlowto}"
        aria-haspopup="${(x) => x.ariaHaspopup}"
        aria-hidden="${(x) => x.ariaHidden}"
        aria-invalid="${(x) => x.ariaInvalid}"
        aria-keyshortcuts="${(x) => x.ariaKeyshortcuts}"
        aria-label="${(x) => x.ariaLabel}"
        aria-labelledby="${(x) => x.ariaLabelledby}"
        aria-live="${(x) => x.ariaLive}"
        aria-owns="${(x) => x.ariaOwns}"
        aria-pressed="${(x) => x.ariaPressed}"
        aria-relevant="${(x) => x.ariaRelevant}"
        aria-roledescription="${(x) => x.ariaRoledescription}"
        ${ref("control")}
    >
        ${startSlotTemplate(context, definition)}
        <span class="content" part="content">
            <slot ${slotted("defaultSlottedContent")}></slot>
        </span>
        ${endSlotTemplate(context, definition)}
    </button>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/form-associated/form-associated.js
  function FormAssociated(BaseCtor) {
    const C = class extends BaseCtor {
      constructor(...args) {
        super(...args);
        this.dirtyValue = false;
        this.disabled = false;
        this.proxyEventsToBlock = ["change", "click"];
        this.proxyInitialized = false;
        this.required = false;
        this.initialValue = this.initialValue || "";
        if (!this.elementInternals) {
          this.formResetCallback = this.formResetCallback.bind(this);
        }
      }
      /**
       * Must evaluate to true to enable elementInternals.
       * Feature detects API support and resolve respectively
       *
       * @internal
       */
      static get formAssociated() {
        return supportsElementInternals;
      }
      /**
       * Returns the validity state of the element
       *
       * @alpha
       */
      get validity() {
        return this.elementInternals ? this.elementInternals.validity : this.proxy.validity;
      }
      /**
       * Retrieve a reference to the associated form.
       * Returns null if not associated to any form.
       *
       * @alpha
       */
      get form() {
        return this.elementInternals ? this.elementInternals.form : this.proxy.form;
      }
      /**
       * Retrieve the localized validation message,
       * or custom validation message if set.
       *
       * @alpha
       */
      get validationMessage() {
        return this.elementInternals ? this.elementInternals.validationMessage : this.proxy.validationMessage;
      }
      /**
       * Whether the element will be validated when the
       * form is submitted
       */
      get willValidate() {
        return this.elementInternals ? this.elementInternals.willValidate : this.proxy.willValidate;
      }
      /**
       * A reference to all associated label elements
       */
      get labels() {
        if (this.elementInternals) {
          return Object.freeze(Array.from(this.elementInternals.labels));
        } else if (this.proxy instanceof HTMLElement && this.proxy.ownerDocument && this.id) {
          const parentLabels = this.proxy.labels;
          const forLabels = Array.from(this.proxy.getRootNode().querySelectorAll(`[for='${this.id}']`));
          const labels = parentLabels ? forLabels.concat(Array.from(parentLabels)) : forLabels;
          return Object.freeze(labels);
        } else {
          return emptyArray;
        }
      }
      /**
       * Invoked when the `value` property changes
       * @param previous - the previous value
       * @param next - the new value
       *
       * @remarks
       * If elements extending `FormAssociated` implement a `valueChanged` method
       * They must be sure to invoke `super.valueChanged(previous, next)` to ensure
       * proper functioning of `FormAssociated`
       */
      valueChanged(previous, next) {
        this.dirtyValue = true;
        if (this.proxy instanceof HTMLElement) {
          this.proxy.value = this.value;
        }
        this.currentValue = this.value;
        this.setFormValue(this.value);
        this.validate();
      }
      currentValueChanged() {
        this.value = this.currentValue;
      }
      /**
       * Invoked when the `initialValue` property changes
       *
       * @param previous - the previous value
       * @param next - the new value
       *
       * @remarks
       * If elements extending `FormAssociated` implement a `initialValueChanged` method
       * They must be sure to invoke `super.initialValueChanged(previous, next)` to ensure
       * proper functioning of `FormAssociated`
       */
      initialValueChanged(previous, next) {
        if (!this.dirtyValue) {
          this.value = this.initialValue;
          this.dirtyValue = false;
        }
      }
      /**
       * Invoked when the `disabled` property changes
       *
       * @param previous - the previous value
       * @param next - the new value
       *
       * @remarks
       * If elements extending `FormAssociated` implement a `disabledChanged` method
       * They must be sure to invoke `super.disabledChanged(previous, next)` to ensure
       * proper functioning of `FormAssociated`
       */
      disabledChanged(previous, next) {
        if (this.proxy instanceof HTMLElement) {
          this.proxy.disabled = this.disabled;
        }
        DOM.queueUpdate(() => this.classList.toggle("disabled", this.disabled));
      }
      /**
       * Invoked when the `name` property changes
       *
       * @param previous - the previous value
       * @param next - the new value
       *
       * @remarks
       * If elements extending `FormAssociated` implement a `nameChanged` method
       * They must be sure to invoke `super.nameChanged(previous, next)` to ensure
       * proper functioning of `FormAssociated`
       */
      nameChanged(previous, next) {
        if (this.proxy instanceof HTMLElement) {
          this.proxy.name = this.name;
        }
      }
      /**
       * Invoked when the `required` property changes
       *
       * @param previous - the previous value
       * @param next - the new value
       *
       * @remarks
       * If elements extending `FormAssociated` implement a `requiredChanged` method
       * They must be sure to invoke `super.requiredChanged(previous, next)` to ensure
       * proper functioning of `FormAssociated`
       */
      requiredChanged(prev, next) {
        if (this.proxy instanceof HTMLElement) {
          this.proxy.required = this.required;
        }
        DOM.queueUpdate(() => this.classList.toggle("required", this.required));
        this.validate();
      }
      /**
       * The element internals object. Will only exist
       * in browsers supporting the attachInternals API
       */
      get elementInternals() {
        if (!supportsElementInternals) {
          return null;
        }
        let internals = InternalsMap.get(this);
        if (!internals) {
          internals = this.attachInternals();
          InternalsMap.set(this, internals);
        }
        return internals;
      }
      /**
       * @internal
       */
      connectedCallback() {
        super.connectedCallback();
        this.addEventListener("keypress", this._keypressHandler);
        if (!this.value) {
          this.value = this.initialValue;
          this.dirtyValue = false;
        }
        if (!this.elementInternals) {
          this.attachProxy();
          if (this.form) {
            this.form.addEventListener("reset", this.formResetCallback);
          }
        }
      }
      /**
       * @internal
       */
      disconnectedCallback() {
        super.disconnectedCallback();
        this.proxyEventsToBlock.forEach((name) => this.proxy.removeEventListener(name, this.stopPropagation));
        if (!this.elementInternals && this.form) {
          this.form.removeEventListener("reset", this.formResetCallback);
        }
      }
      /**
       * Return the current validity of the element.
       */
      checkValidity() {
        return this.elementInternals ? this.elementInternals.checkValidity() : this.proxy.checkValidity();
      }
      /**
       * Return the current validity of the element.
       * If false, fires an invalid event at the element.
       */
      reportValidity() {
        return this.elementInternals ? this.elementInternals.reportValidity() : this.proxy.reportValidity();
      }
      /**
       * Set the validity of the control. In cases when the elementInternals object is not
       * available (and the proxy element is used to report validity), this function will
       * do nothing unless a message is provided, at which point the setCustomValidity method
       * of the proxy element will be invoked with the provided message.
       * @param flags - Validity flags
       * @param message - Optional message to supply
       * @param anchor - Optional element used by UA to display an interactive validation UI
       */
      setValidity(flags, message, anchor) {
        if (this.elementInternals) {
          this.elementInternals.setValidity(flags, message, anchor);
        } else if (typeof message === "string") {
          this.proxy.setCustomValidity(message);
        }
      }
      /**
       * Invoked when a connected component's form or fieldset has its disabled
       * state changed.
       * @param disabled - the disabled value of the form / fieldset
       */
      formDisabledCallback(disabled) {
        this.disabled = disabled;
      }
      formResetCallback() {
        this.value = this.initialValue;
        this.dirtyValue = false;
      }
      /**
       * Attach the proxy element to the DOM
       */
      attachProxy() {
        var _a;
        if (!this.proxyInitialized) {
          this.proxyInitialized = true;
          this.proxy.style.display = "none";
          this.proxyEventsToBlock.forEach((name) => this.proxy.addEventListener(name, this.stopPropagation));
          this.proxy.disabled = this.disabled;
          this.proxy.required = this.required;
          if (typeof this.name === "string") {
            this.proxy.name = this.name;
          }
          if (typeof this.value === "string") {
            this.proxy.value = this.value;
          }
          this.proxy.setAttribute("slot", proxySlotName);
          this.proxySlot = document.createElement("slot");
          this.proxySlot.setAttribute("name", proxySlotName);
        }
        (_a = this.shadowRoot) === null || _a === void 0 ? void 0 : _a.appendChild(this.proxySlot);
        this.appendChild(this.proxy);
      }
      /**
       * Detach the proxy element from the DOM
       */
      detachProxy() {
        var _a;
        this.removeChild(this.proxy);
        (_a = this.shadowRoot) === null || _a === void 0 ? void 0 : _a.removeChild(this.proxySlot);
      }
      /** {@inheritDoc (FormAssociated:interface).validate} */
      validate(anchor) {
        if (this.proxy instanceof HTMLElement) {
          this.setValidity(this.proxy.validity, this.proxy.validationMessage, anchor);
        }
      }
      /**
       * Associates the provided value (and optional state) with the parent form.
       * @param value - The value to set
       * @param state - The state object provided to during session restores and when autofilling.
       */
      setFormValue(value, state) {
        if (this.elementInternals) {
          this.elementInternals.setFormValue(value, state || value);
        }
      }
      _keypressHandler(e) {
        switch (e.key) {
          case keyEnter:
            if (this.form instanceof HTMLFormElement) {
              const defaultButton = this.form.querySelector("[type=submit]");
              defaultButton === null || defaultButton === void 0 ? void 0 : defaultButton.click();
            }
            break;
        }
      }
      /**
       * Used to stop propagation of proxy element events
       * @param e - Event object
       */
      stopPropagation(e) {
        e.stopPropagation();
      }
    };
    attr({ mode: "boolean" })(C.prototype, "disabled");
    attr({ mode: "fromView", attribute: "value" })(C.prototype, "initialValue");
    attr({ attribute: "current-value" })(C.prototype, "currentValue");
    attr(C.prototype, "name");
    attr({ mode: "boolean" })(C.prototype, "required");
    observable(C.prototype, "value");
    return C;
  }
  function CheckableFormAssociated(BaseCtor) {
    class C extends FormAssociated(BaseCtor) {
    }
    class D extends C {
      constructor(...args) {
        super(args);
        this.dirtyChecked = false;
        this.checkedAttribute = false;
        this.checked = false;
        this.dirtyChecked = false;
      }
      checkedAttributeChanged() {
        this.defaultChecked = this.checkedAttribute;
      }
      /**
       * @internal
       */
      defaultCheckedChanged() {
        if (!this.dirtyChecked) {
          this.checked = this.defaultChecked;
          this.dirtyChecked = false;
        }
      }
      checkedChanged(prev, next) {
        if (!this.dirtyChecked) {
          this.dirtyChecked = true;
        }
        this.currentChecked = this.checked;
        this.updateForm();
        if (this.proxy instanceof HTMLInputElement) {
          this.proxy.checked = this.checked;
        }
        if (prev !== void 0) {
          this.$emit("change");
        }
        this.validate();
      }
      currentCheckedChanged(prev, next) {
        this.checked = this.currentChecked;
      }
      updateForm() {
        const value = this.checked ? this.value : null;
        this.setFormValue(value, value);
      }
      connectedCallback() {
        super.connectedCallback();
        this.updateForm();
      }
      formResetCallback() {
        super.formResetCallback();
        this.checked = !!this.checkedAttribute;
        this.dirtyChecked = false;
      }
    }
    attr({ attribute: "checked", mode: "boolean" })(D.prototype, "checkedAttribute");
    attr({ attribute: "current-checked", converter: booleanConverter })(D.prototype, "currentChecked");
    observable(D.prototype, "defaultChecked");
    observable(D.prototype, "checked");
    return D;
  }
  var proxySlotName, ElementInternalsKey, supportsElementInternals, InternalsMap;
  var init_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/form-associated/form-associated.js"() {
      init_esm();
      init_dist2();
      proxySlotName = "form-associated-proxy";
      ElementInternalsKey = "ElementInternals";
      supportsElementInternals = ElementInternalsKey in window && "setFormValue" in window[ElementInternalsKey].prototype;
      InternalsMap = /* @__PURE__ */ new WeakMap();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/button/button.form-associated.js
  var _Button, FormAssociatedButton;
  var init_button_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/button/button.form-associated.js"() {
      init_form_associated();
      init_foundation_element();
      _Button = class extends FoundationElement {
      };
      FormAssociatedButton = class extends FormAssociated(_Button) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("input");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/button/button.js
  var Button, DelegatesARIAButton;
  var init_button = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/button/button.js"() {
      init_tslib_es6();
      init_esm();
      init_patterns();
      init_apply_mixins();
      init_button_form_associated();
      Button = class extends FormAssociatedButton {
        constructor() {
          super(...arguments);
          this.handleClick = (e) => {
            var _a;
            if (this.disabled && ((_a = this.defaultSlottedContent) === null || _a === void 0 ? void 0 : _a.length) <= 1) {
              e.stopPropagation();
            }
          };
          this.handleSubmission = () => {
            if (!this.form) {
              return;
            }
            const attached = this.proxy.isConnected;
            if (!attached) {
              this.attachProxy();
            }
            typeof this.form.requestSubmit === "function" ? this.form.requestSubmit(this.proxy) : this.proxy.click();
            if (!attached) {
              this.detachProxy();
            }
          };
          this.handleFormReset = () => {
            var _a;
            (_a = this.form) === null || _a === void 0 ? void 0 : _a.reset();
          };
          this.handleUnsupportedDelegatesFocus = () => {
            var _a;
            if (window.ShadowRoot && !window.ShadowRoot.prototype.hasOwnProperty("delegatesFocus") && ((_a = this.$fastController.definition.shadowOptions) === null || _a === void 0 ? void 0 : _a.delegatesFocus)) {
              this.focus = () => {
                this.control.focus();
              };
            }
          };
        }
        formactionChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.formAction = this.formaction;
          }
        }
        formenctypeChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.formEnctype = this.formenctype;
          }
        }
        formmethodChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.formMethod = this.formmethod;
          }
        }
        formnovalidateChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.formNoValidate = this.formnovalidate;
          }
        }
        formtargetChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.formTarget = this.formtarget;
          }
        }
        typeChanged(previous, next) {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.type = this.type;
          }
          next === "submit" && this.addEventListener("click", this.handleSubmission);
          previous === "submit" && this.removeEventListener("click", this.handleSubmission);
          next === "reset" && this.addEventListener("click", this.handleFormReset);
          previous === "reset" && this.removeEventListener("click", this.handleFormReset);
        }
        /** {@inheritDoc (FormAssociated:interface).validate} */
        validate() {
          super.validate(this.control);
        }
        /**
         * @internal
         */
        connectedCallback() {
          var _a;
          super.connectedCallback();
          this.proxy.setAttribute("type", this.type);
          this.handleUnsupportedDelegatesFocus();
          const elements2 = Array.from((_a = this.control) === null || _a === void 0 ? void 0 : _a.children);
          if (elements2) {
            elements2.forEach((span) => {
              span.addEventListener("click", this.handleClick);
            });
          }
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          var _a;
          super.disconnectedCallback();
          const elements2 = Array.from((_a = this.control) === null || _a === void 0 ? void 0 : _a.children);
          if (elements2) {
            elements2.forEach((span) => {
              span.removeEventListener("click", this.handleClick);
            });
          }
        }
      };
      __decorate([
        attr({ mode: "boolean" })
      ], Button.prototype, "autofocus", void 0);
      __decorate([
        attr({ attribute: "form" })
      ], Button.prototype, "formId", void 0);
      __decorate([
        attr
      ], Button.prototype, "formaction", void 0);
      __decorate([
        attr
      ], Button.prototype, "formenctype", void 0);
      __decorate([
        attr
      ], Button.prototype, "formmethod", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], Button.prototype, "formnovalidate", void 0);
      __decorate([
        attr
      ], Button.prototype, "formtarget", void 0);
      __decorate([
        attr
      ], Button.prototype, "type", void 0);
      __decorate([
        observable
      ], Button.prototype, "defaultSlottedContent", void 0);
      DelegatesARIAButton = class {
      };
      __decorate([
        attr({ attribute: "aria-expanded" })
      ], DelegatesARIAButton.prototype, "ariaExpanded", void 0);
      __decorate([
        attr({ attribute: "aria-pressed" })
      ], DelegatesARIAButton.prototype, "ariaPressed", void 0);
      applyMixins(DelegatesARIAButton, ARIAGlobalStatesAndProperties);
      applyMixins(Button, StartEnd, DelegatesARIAButton);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/button/index.js
  var init_button2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/button/index.js"() {
      init_button_template();
      init_button();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/calendar/date-formatter.js
  var DateFormatter;
  var init_date_formatter = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/calendar/date-formatter.js"() {
      DateFormatter = class {
        constructor(config) {
          this.dayFormat = "numeric";
          this.weekdayFormat = "long";
          this.monthFormat = "long";
          this.yearFormat = "numeric";
          this.date = /* @__PURE__ */ new Date();
          if (config) {
            for (const key in config) {
              const value = config[key];
              if (key === "date") {
                this.date = this.getDateObject(value);
              } else {
                this[key] = value;
              }
            }
          }
        }
        /**
         * Helper function to make sure that the DateFormatter is working with an instance of Date
         * @param date - The date as an object, string or Date insance
         * @returns - A Date instance
         * @public
         */
        getDateObject(date) {
          if (typeof date === "string") {
            const dates = date.split(/[/-]/);
            if (dates.length < 3) {
              return /* @__PURE__ */ new Date();
            }
            return new Date(parseInt(dates[2], 10), parseInt(dates[0], 10) - 1, parseInt(dates[1], 10));
          } else if ("day" in date && "month" in date && "year" in date) {
            const { day, month, year } = date;
            return new Date(year, month - 1, day);
          }
          return date;
        }
        /**
         *
         * @param date - a valide date as either a Date, string, objec or a DateFormatter
         * @param format - The formatting for the string
         * @param locale - locale data used for formatting
         * @returns A localized string of the date provided
         * @public
         */
        getDate(date = this.date, format = {
          weekday: this.weekdayFormat,
          month: this.monthFormat,
          day: this.dayFormat,
          year: this.yearFormat
        }, locale = this.locale) {
          const dateObj = this.getDateObject(date);
          if (!dateObj.getTime()) {
            return "";
          }
          const optionsWithTimeZone = Object.assign({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, format);
          return new Intl.DateTimeFormat(locale, optionsWithTimeZone).format(dateObj);
        }
        /**
         *
         * @param day - Day to localize
         * @param format - The formatting for the day
         * @param locale - The locale data used for formatting
         * @returns - A localized number for the day
         * @public
         */
        getDay(day = this.date.getDate(), format = this.dayFormat, locale = this.locale) {
          return this.getDate({ month: 1, day, year: 2020 }, { day: format }, locale);
        }
        /**
         *
         * @param month - The month to localize
         * @param format - The formatting for the month
         * @param locale - The locale data used for formatting
         * @returns - A localized name of the month
         * @public
         */
        getMonth(month = this.date.getMonth() + 1, format = this.monthFormat, locale = this.locale) {
          return this.getDate({ month, day: 2, year: 2020 }, { month: format }, locale);
        }
        /**
         *
         * @param year - The year to localize
         * @param format - The formatting for the year
         * @param locale - The locale data used for formatting
         * @returns - A localized string for the year
         * @public
         */
        getYear(year = this.date.getFullYear(), format = this.yearFormat, locale = this.locale) {
          return this.getDate({ month: 2, day: 2, year }, { year: format }, locale);
        }
        /**
         *
         * @param weekday - The number of the weekday, defaults to Sunday
         * @param format - The formatting for the weekday label
         * @param locale - The locale data used for formatting
         * @returns - A formatted weekday label
         * @public
         */
        getWeekday(weekday = 0, format = this.weekdayFormat, locale = this.locale) {
          const date = `1-${weekday + 1}-2017`;
          return this.getDate(date, { weekday: format }, locale);
        }
        /**
         *
         * @param format - The formatting for the weekdays
         * @param locale - The locale data used for formatting
         * @returns - An array of the weekday labels
         * @public
         */
        getWeekdays(format = this.weekdayFormat, locale = this.locale) {
          return Array(7).fill(null).map((_, day) => this.getWeekday(day, format, locale));
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/calendar/calendar.js
  var Calendar;
  var init_calendar = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/calendar/calendar.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_foundation_element();
      init_date_formatter();
      Calendar = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.dateFormatter = new DateFormatter();
          this.readonly = false;
          this.locale = "en-US";
          this.month = (/* @__PURE__ */ new Date()).getMonth() + 1;
          this.year = (/* @__PURE__ */ new Date()).getFullYear();
          this.dayFormat = "numeric";
          this.weekdayFormat = "short";
          this.monthFormat = "long";
          this.yearFormat = "numeric";
          this.minWeeks = 0;
          this.disabledDates = "";
          this.selectedDates = "";
          this.oneDayInMs = 864e5;
        }
        localeChanged() {
          this.dateFormatter.locale = this.locale;
        }
        dayFormatChanged() {
          this.dateFormatter.dayFormat = this.dayFormat;
        }
        weekdayFormatChanged() {
          this.dateFormatter.weekdayFormat = this.weekdayFormat;
        }
        monthFormatChanged() {
          this.dateFormatter.monthFormat = this.monthFormat;
        }
        yearFormatChanged() {
          this.dateFormatter.yearFormat = this.yearFormat;
        }
        /**
         * Gets data needed to render about a calendar month as well as the previous and next months
         * @param year - year of the calendar
         * @param month - month of the calendar
         * @returns - an object with data about the current and 2 surrounding months
         * @public
         */
        getMonthInfo(month = this.month, year = this.year) {
          const getFirstDay = (date) => new Date(date.getFullYear(), date.getMonth(), 1).getDay();
          const getLength = (date) => {
            const nextMonth2 = new Date(date.getFullYear(), date.getMonth() + 1, 1);
            return new Date(nextMonth2.getTime() - this.oneDayInMs).getDate();
          };
          const thisMonth = new Date(year, month - 1);
          const nextMonth = new Date(year, month);
          const previousMonth = new Date(year, month - 2);
          return {
            length: getLength(thisMonth),
            month,
            start: getFirstDay(thisMonth),
            year,
            previous: {
              length: getLength(previousMonth),
              month: previousMonth.getMonth() + 1,
              start: getFirstDay(previousMonth),
              year: previousMonth.getFullYear()
            },
            next: {
              length: getLength(nextMonth),
              month: nextMonth.getMonth() + 1,
              start: getFirstDay(nextMonth),
              year: nextMonth.getFullYear()
            }
          };
        }
        /**
         * A list of calendar days
         * @param info - an object containing the information needed to render a calendar month
         * @param minWeeks - minimum number of weeks to show
         * @returns a list of days in a calendar month
         * @public
         */
        getDays(info = this.getMonthInfo(), minWeeks = this.minWeeks) {
          minWeeks = minWeeks > 10 ? 10 : minWeeks;
          const { start, length, previous, next } = info;
          const days = [];
          let dayCount = 1 - start;
          while (dayCount < length + 1 || days.length < minWeeks || days[days.length - 1].length % 7 !== 0) {
            const { month, year } = dayCount < 1 ? previous : dayCount > length ? next : info;
            const day = dayCount < 1 ? previous.length + dayCount : dayCount > length ? dayCount - length : dayCount;
            const dateString = `${month}-${day}-${year}`;
            const disabled = this.dateInString(dateString, this.disabledDates);
            const selected = this.dateInString(dateString, this.selectedDates);
            const date = {
              day,
              month,
              year,
              disabled,
              selected
            };
            const target = days[days.length - 1];
            if (days.length === 0 || target.length % 7 === 0) {
              days.push([date]);
            } else {
              target.push(date);
            }
            dayCount++;
          }
          return days;
        }
        /**
         * A helper function that checks if a date exists in a list of dates
         * @param date - A date objec that includes the day, month and year
         * @param datesString - a comma separated list of dates
         * @returns - Returns true if it found the date in the list of dates
         * @public
         */
        dateInString(date, datesString) {
          const dates = datesString.split(",").map((str) => str.trim());
          date = typeof date === "string" ? date : `${date.getMonth() + 1}-${date.getDate()}-${date.getFullYear()}`;
          return dates.some((d) => d === date);
        }
        /**
         * Creates a class string for the day container
         * @param date - date of the calendar cell
         * @returns - string of class names
         * @public
         */
        getDayClassNames(date, todayString) {
          const { day, month, year, disabled, selected } = date;
          const today = todayString === `${month}-${day}-${year}`;
          const inactive = this.month !== month;
          return [
            "day",
            today && "today",
            inactive && "inactive",
            disabled && "disabled",
            selected && "selected"
          ].filter(Boolean).join(" ");
        }
        /**
         * Returns a list of weekday labels
         * @returns An array of weekday text and full text if abbreviated
         * @public
         */
        getWeekdayText() {
          const weekdayText = this.dateFormatter.getWeekdays().map((text) => ({ text }));
          if (this.weekdayFormat !== "long") {
            const longText = this.dateFormatter.getWeekdays("long");
            weekdayText.forEach((weekday, index) => {
              weekday.abbr = longText[index];
            });
          }
          return weekdayText;
        }
        /**
         * Emits the "date-select" event with the day, month and year.
         * @param date - Date cell
         * @public
         */
        handleDateSelect(event, day) {
          event.preventDefault;
          this.$emit("dateselected", day);
        }
        /**
         * Handles keyboard events on a cell
         * @param event - Keyboard event
         * @param date - Date of the cell selected
         */
        handleKeydown(event, date) {
          if (event.key === keyEnter) {
            this.handleDateSelect(event, date);
          }
          return true;
        }
      };
      __decorate([
        attr({ mode: "boolean" })
      ], Calendar.prototype, "readonly", void 0);
      __decorate([
        attr
      ], Calendar.prototype, "locale", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], Calendar.prototype, "month", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], Calendar.prototype, "year", void 0);
      __decorate([
        attr({ attribute: "day-format", mode: "fromView" })
      ], Calendar.prototype, "dayFormat", void 0);
      __decorate([
        attr({ attribute: "weekday-format", mode: "fromView" })
      ], Calendar.prototype, "weekdayFormat", void 0);
      __decorate([
        attr({ attribute: "month-format", mode: "fromView" })
      ], Calendar.prototype, "monthFormat", void 0);
      __decorate([
        attr({ attribute: "year-format", mode: "fromView" })
      ], Calendar.prototype, "yearFormat", void 0);
      __decorate([
        attr({ attribute: "min-weeks", converter: nullableNumberConverter })
      ], Calendar.prototype, "minWeeks", void 0);
      __decorate([
        attr({ attribute: "disabled-dates" })
      ], Calendar.prototype, "disabledDates", void 0);
      __decorate([
        attr({ attribute: "selected-dates" })
      ], Calendar.prototype, "selectedDates", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid.options.js
  var GenerateHeaderOptions, DataGridCellTypes, DataGridRowTypes;
  var init_data_grid_options = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid.options.js"() {
      GenerateHeaderOptions = {
        none: "none",
        default: "default",
        sticky: "sticky"
      };
      DataGridCellTypes = {
        default: "default",
        columnHeader: "columnheader",
        rowHeader: "rowheader"
      };
      DataGridRowTypes = {
        default: "default",
        header: "header",
        stickyHeader: "sticky-header"
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid-row.js
  var DataGridRow;
  var init_data_grid_row = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid-row.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_foundation_element();
      init_data_grid_options();
      DataGridRow = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.rowType = DataGridRowTypes.default;
          this.rowData = null;
          this.columnDefinitions = null;
          this.isActiveRow = false;
          this.cellsRepeatBehavior = null;
          this.cellsPlaceholder = null;
          this.focusColumnIndex = 0;
          this.refocusOnLoad = false;
          this.updateRowStyle = () => {
            this.style.gridTemplateColumns = this.gridTemplateColumns;
          };
        }
        gridTemplateColumnsChanged() {
          if (this.$fastController.isConnected) {
            this.updateRowStyle();
          }
        }
        rowTypeChanged() {
          if (this.$fastController.isConnected) {
            this.updateItemTemplate();
          }
        }
        rowDataChanged() {
          if (this.rowData !== null && this.isActiveRow) {
            this.refocusOnLoad = true;
            return;
          }
        }
        cellItemTemplateChanged() {
          this.updateItemTemplate();
        }
        headerCellItemTemplateChanged() {
          this.updateItemTemplate();
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.cellsRepeatBehavior === null) {
            this.cellsPlaceholder = document.createComment("");
            this.appendChild(this.cellsPlaceholder);
            this.updateItemTemplate();
            this.cellsRepeatBehavior = new RepeatDirective((x) => x.columnDefinitions, (x) => x.activeCellItemTemplate, { positioning: true }).createBehavior(this.cellsPlaceholder);
            this.$fastController.addBehaviors([this.cellsRepeatBehavior]);
          }
          this.addEventListener("cell-focused", this.handleCellFocus);
          this.addEventListener(eventFocusOut, this.handleFocusout);
          this.addEventListener(eventKeyDown, this.handleKeydown);
          this.updateRowStyle();
          if (this.refocusOnLoad) {
            this.refocusOnLoad = false;
            if (this.cellElements.length > this.focusColumnIndex) {
              this.cellElements[this.focusColumnIndex].focus();
            }
          }
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          super.disconnectedCallback();
          this.removeEventListener("cell-focused", this.handleCellFocus);
          this.removeEventListener(eventFocusOut, this.handleFocusout);
          this.removeEventListener(eventKeyDown, this.handleKeydown);
        }
        handleFocusout(e) {
          if (!this.contains(e.target)) {
            this.isActiveRow = false;
            this.focusColumnIndex = 0;
          }
        }
        handleCellFocus(e) {
          this.isActiveRow = true;
          this.focusColumnIndex = this.cellElements.indexOf(e.target);
          this.$emit("row-focused", this);
        }
        handleKeydown(e) {
          if (e.defaultPrevented) {
            return;
          }
          let newFocusColumnIndex = 0;
          switch (e.key) {
            case keyArrowLeft:
              newFocusColumnIndex = Math.max(0, this.focusColumnIndex - 1);
              this.cellElements[newFocusColumnIndex].focus();
              e.preventDefault();
              break;
            case keyArrowRight:
              newFocusColumnIndex = Math.min(this.cellElements.length - 1, this.focusColumnIndex + 1);
              this.cellElements[newFocusColumnIndex].focus();
              e.preventDefault();
              break;
            case keyHome:
              if (!e.ctrlKey) {
                this.cellElements[0].focus();
                e.preventDefault();
              }
              break;
            case keyEnd:
              if (!e.ctrlKey) {
                this.cellElements[this.cellElements.length - 1].focus();
                e.preventDefault();
              }
              break;
          }
        }
        updateItemTemplate() {
          this.activeCellItemTemplate = this.rowType === DataGridRowTypes.default && this.cellItemTemplate !== void 0 ? this.cellItemTemplate : this.rowType === DataGridRowTypes.default && this.cellItemTemplate === void 0 ? this.defaultCellItemTemplate : this.headerCellItemTemplate !== void 0 ? this.headerCellItemTemplate : this.defaultHeaderCellItemTemplate;
        }
      };
      __decorate([
        attr({ attribute: "grid-template-columns" })
      ], DataGridRow.prototype, "gridTemplateColumns", void 0);
      __decorate([
        attr({ attribute: "row-type" })
      ], DataGridRow.prototype, "rowType", void 0);
      __decorate([
        observable
      ], DataGridRow.prototype, "rowData", void 0);
      __decorate([
        observable
      ], DataGridRow.prototype, "columnDefinitions", void 0);
      __decorate([
        observable
      ], DataGridRow.prototype, "cellItemTemplate", void 0);
      __decorate([
        observable
      ], DataGridRow.prototype, "headerCellItemTemplate", void 0);
      __decorate([
        observable
      ], DataGridRow.prototype, "rowIndex", void 0);
      __decorate([
        observable
      ], DataGridRow.prototype, "isActiveRow", void 0);
      __decorate([
        observable
      ], DataGridRow.prototype, "activeCellItemTemplate", void 0);
      __decorate([
        observable
      ], DataGridRow.prototype, "defaultCellItemTemplate", void 0);
      __decorate([
        observable
      ], DataGridRow.prototype, "defaultHeaderCellItemTemplate", void 0);
      __decorate([
        observable
      ], DataGridRow.prototype, "cellElements", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid.template.js
  function createRowItemTemplate(context) {
    const rowTag = context.tagFor(DataGridRow);
    return html`
    <${rowTag}
        :rowData="${(x) => x}"
        :cellItemTemplate="${(x, c) => c.parent.cellItemTemplate}"
        :headerCellItemTemplate="${(x, c) => c.parent.headerCellItemTemplate}"
    ></${rowTag}>
`;
  }
  var dataGridTemplate;
  var init_data_grid_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid.template.js"() {
      init_esm();
      init_data_grid_row();
      dataGridTemplate = (context, definition) => {
        const rowItemTemplate = createRowItemTemplate(context);
        const rowTag = context.tagFor(DataGridRow);
        return html`
        <template
            role="grid"
            tabindex="0"
            :rowElementTag="${() => rowTag}"
            :defaultRowItemTemplate="${rowItemTemplate}"
            ${children({
          property: "rowElements",
          filter: elements("[role=row]")
        })}
        >
            <slot></slot>
        </template>
    `;
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid.js
  var DataGrid;
  var init_data_grid = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_foundation_element();
      init_data_grid_options();
      DataGrid = class _DataGrid extends FoundationElement {
        constructor() {
          super();
          this.noTabbing = false;
          this.generateHeader = GenerateHeaderOptions.default;
          this.rowsData = [];
          this.columnDefinitions = null;
          this.focusRowIndex = 0;
          this.focusColumnIndex = 0;
          this.rowsPlaceholder = null;
          this.generatedHeader = null;
          this.isUpdatingFocus = false;
          this.pendingFocusUpdate = false;
          this.rowindexUpdateQueued = false;
          this.columnDefinitionsStale = true;
          this.generatedGridTemplateColumns = "";
          this.focusOnCell = (rowIndex, columnIndex, scrollIntoView) => {
            if (this.rowElements.length === 0) {
              this.focusRowIndex = 0;
              this.focusColumnIndex = 0;
              return;
            }
            const focusRowIndex = Math.max(0, Math.min(this.rowElements.length - 1, rowIndex));
            const focusRow = this.rowElements[focusRowIndex];
            const cells = focusRow.querySelectorAll('[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]');
            const focusColumnIndex = Math.max(0, Math.min(cells.length - 1, columnIndex));
            const focusTarget = cells[focusColumnIndex];
            if (scrollIntoView && this.scrollHeight !== this.clientHeight && (focusRowIndex < this.focusRowIndex && this.scrollTop > 0 || focusRowIndex > this.focusRowIndex && this.scrollTop < this.scrollHeight - this.clientHeight)) {
              focusTarget.scrollIntoView({ block: "center", inline: "center" });
            }
            focusTarget.focus();
          };
          this.onChildListChange = (mutations, observer) => {
            if (mutations && mutations.length) {
              mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((newNode) => {
                  if (newNode.nodeType === 1 && newNode.getAttribute("role") === "row") {
                    newNode.columnDefinitions = this.columnDefinitions;
                  }
                });
              });
              this.queueRowIndexUpdate();
            }
          };
          this.queueRowIndexUpdate = () => {
            if (!this.rowindexUpdateQueued) {
              this.rowindexUpdateQueued = true;
              DOM.queueUpdate(this.updateRowIndexes);
            }
          };
          this.updateRowIndexes = () => {
            let newGridTemplateColumns = this.gridTemplateColumns;
            if (newGridTemplateColumns === void 0) {
              if (this.generatedGridTemplateColumns === "" && this.rowElements.length > 0) {
                const firstRow = this.rowElements[0];
                this.generatedGridTemplateColumns = new Array(firstRow.cellElements.length).fill("1fr").join(" ");
              }
              newGridTemplateColumns = this.generatedGridTemplateColumns;
            }
            this.rowElements.forEach((element, index) => {
              const thisRow = element;
              thisRow.rowIndex = index;
              thisRow.gridTemplateColumns = newGridTemplateColumns;
              if (this.columnDefinitionsStale) {
                thisRow.columnDefinitions = this.columnDefinitions;
              }
            });
            this.rowindexUpdateQueued = false;
            this.columnDefinitionsStale = false;
          };
        }
        /**
         *  generates a gridTemplateColumns based on columndata array
         */
        static generateTemplateColumns(columnDefinitions) {
          let templateColumns = "";
          columnDefinitions.forEach((column) => {
            templateColumns = `${templateColumns}${templateColumns === "" ? "" : " "}${"1fr"}`;
          });
          return templateColumns;
        }
        noTabbingChanged() {
          if (this.$fastController.isConnected) {
            if (this.noTabbing) {
              this.setAttribute("tabIndex", "-1");
            } else {
              this.setAttribute("tabIndex", this.contains(document.activeElement) || this === document.activeElement ? "-1" : "0");
            }
          }
        }
        generateHeaderChanged() {
          if (this.$fastController.isConnected) {
            this.toggleGeneratedHeader();
          }
        }
        gridTemplateColumnsChanged() {
          if (this.$fastController.isConnected) {
            this.updateRowIndexes();
          }
        }
        rowsDataChanged() {
          if (this.columnDefinitions === null && this.rowsData.length > 0) {
            this.columnDefinitions = _DataGrid.generateColumns(this.rowsData[0]);
          }
          if (this.$fastController.isConnected) {
            this.toggleGeneratedHeader();
          }
        }
        columnDefinitionsChanged() {
          if (this.columnDefinitions === null) {
            this.generatedGridTemplateColumns = "";
            return;
          }
          this.generatedGridTemplateColumns = _DataGrid.generateTemplateColumns(this.columnDefinitions);
          if (this.$fastController.isConnected) {
            this.columnDefinitionsStale = true;
            this.queueRowIndexUpdate();
          }
        }
        headerCellItemTemplateChanged() {
          if (this.$fastController.isConnected) {
            if (this.generatedHeader !== null) {
              this.generatedHeader.headerCellItemTemplate = this.headerCellItemTemplate;
            }
          }
        }
        focusRowIndexChanged() {
          if (this.$fastController.isConnected) {
            this.queueFocusUpdate();
          }
        }
        focusColumnIndexChanged() {
          if (this.$fastController.isConnected) {
            this.queueFocusUpdate();
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.rowItemTemplate === void 0) {
            this.rowItemTemplate = this.defaultRowItemTemplate;
          }
          this.rowsPlaceholder = document.createComment("");
          this.appendChild(this.rowsPlaceholder);
          this.toggleGeneratedHeader();
          this.rowsRepeatBehavior = new RepeatDirective((x) => x.rowsData, (x) => x.rowItemTemplate, { positioning: true }).createBehavior(this.rowsPlaceholder);
          this.$fastController.addBehaviors([this.rowsRepeatBehavior]);
          this.addEventListener("row-focused", this.handleRowFocus);
          this.addEventListener(eventFocus, this.handleFocus);
          this.addEventListener(eventKeyDown, this.handleKeydown);
          this.addEventListener(eventFocusOut, this.handleFocusOut);
          this.observer = new MutationObserver(this.onChildListChange);
          this.observer.observe(this, { childList: true });
          if (this.noTabbing) {
            this.setAttribute("tabindex", "-1");
          }
          DOM.queueUpdate(this.queueRowIndexUpdate);
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          super.disconnectedCallback();
          this.removeEventListener("row-focused", this.handleRowFocus);
          this.removeEventListener(eventFocus, this.handleFocus);
          this.removeEventListener(eventKeyDown, this.handleKeydown);
          this.removeEventListener(eventFocusOut, this.handleFocusOut);
          this.observer.disconnect();
          this.rowsPlaceholder = null;
          this.generatedHeader = null;
        }
        /**
         * @internal
         */
        handleRowFocus(e) {
          this.isUpdatingFocus = true;
          const focusRow = e.target;
          this.focusRowIndex = this.rowElements.indexOf(focusRow);
          this.focusColumnIndex = focusRow.focusColumnIndex;
          this.setAttribute("tabIndex", "-1");
          this.isUpdatingFocus = false;
        }
        /**
         * @internal
         */
        handleFocus(e) {
          this.focusOnCell(this.focusRowIndex, this.focusColumnIndex, true);
        }
        /**
         * @internal
         */
        handleFocusOut(e) {
          if (e.relatedTarget === null || !this.contains(e.relatedTarget)) {
            this.setAttribute("tabIndex", this.noTabbing ? "-1" : "0");
          }
        }
        /**
         * @internal
         */
        handleKeydown(e) {
          if (e.defaultPrevented) {
            return;
          }
          let newFocusRowIndex;
          const maxIndex = this.rowElements.length - 1;
          const currentGridBottom = this.offsetHeight + this.scrollTop;
          const lastRow = this.rowElements[maxIndex];
          switch (e.key) {
            case keyArrowUp:
              e.preventDefault();
              this.focusOnCell(this.focusRowIndex - 1, this.focusColumnIndex, true);
              break;
            case keyArrowDown:
              e.preventDefault();
              this.focusOnCell(this.focusRowIndex + 1, this.focusColumnIndex, true);
              break;
            case keyPageUp:
              e.preventDefault();
              if (this.rowElements.length === 0) {
                this.focusOnCell(0, 0, false);
                break;
              }
              if (this.focusRowIndex === 0) {
                this.focusOnCell(0, this.focusColumnIndex, false);
                return;
              }
              newFocusRowIndex = this.focusRowIndex - 1;
              for (newFocusRowIndex; newFocusRowIndex >= 0; newFocusRowIndex--) {
                const thisRow = this.rowElements[newFocusRowIndex];
                if (thisRow.offsetTop < this.scrollTop) {
                  this.scrollTop = thisRow.offsetTop + thisRow.clientHeight - this.clientHeight;
                  break;
                }
              }
              this.focusOnCell(newFocusRowIndex, this.focusColumnIndex, false);
              break;
            case keyPageDown:
              e.preventDefault();
              if (this.rowElements.length === 0) {
                this.focusOnCell(0, 0, false);
                break;
              }
              if (this.focusRowIndex >= maxIndex || lastRow.offsetTop + lastRow.offsetHeight <= currentGridBottom) {
                this.focusOnCell(maxIndex, this.focusColumnIndex, false);
                return;
              }
              newFocusRowIndex = this.focusRowIndex + 1;
              for (newFocusRowIndex; newFocusRowIndex <= maxIndex; newFocusRowIndex++) {
                const thisRow = this.rowElements[newFocusRowIndex];
                if (thisRow.offsetTop + thisRow.offsetHeight > currentGridBottom) {
                  let stickyHeaderOffset = 0;
                  if (this.generateHeader === GenerateHeaderOptions.sticky && this.generatedHeader !== null) {
                    stickyHeaderOffset = this.generatedHeader.clientHeight;
                  }
                  this.scrollTop = thisRow.offsetTop - stickyHeaderOffset;
                  break;
                }
              }
              this.focusOnCell(newFocusRowIndex, this.focusColumnIndex, false);
              break;
            case keyHome:
              if (e.ctrlKey) {
                e.preventDefault();
                this.focusOnCell(0, 0, true);
              }
              break;
            case keyEnd:
              if (e.ctrlKey && this.columnDefinitions !== null) {
                e.preventDefault();
                this.focusOnCell(this.rowElements.length - 1, this.columnDefinitions.length - 1, true);
              }
              break;
          }
        }
        queueFocusUpdate() {
          if (this.isUpdatingFocus && (this.contains(document.activeElement) || this === document.activeElement)) {
            return;
          }
          if (this.pendingFocusUpdate === false) {
            this.pendingFocusUpdate = true;
            DOM.queueUpdate(() => this.updateFocus());
          }
        }
        updateFocus() {
          this.pendingFocusUpdate = false;
          this.focusOnCell(this.focusRowIndex, this.focusColumnIndex, true);
        }
        toggleGeneratedHeader() {
          if (this.generatedHeader !== null) {
            this.removeChild(this.generatedHeader);
            this.generatedHeader = null;
          }
          if (this.generateHeader !== GenerateHeaderOptions.none && this.rowsData.length > 0) {
            const generatedHeaderElement = document.createElement(this.rowElementTag);
            this.generatedHeader = generatedHeaderElement;
            this.generatedHeader.columnDefinitions = this.columnDefinitions;
            this.generatedHeader.gridTemplateColumns = this.gridTemplateColumns;
            this.generatedHeader.rowType = this.generateHeader === GenerateHeaderOptions.sticky ? DataGridRowTypes.stickyHeader : DataGridRowTypes.header;
            if (this.firstChild !== null || this.rowsPlaceholder !== null) {
              this.insertBefore(generatedHeaderElement, this.firstChild !== null ? this.firstChild : this.rowsPlaceholder);
            }
            return;
          }
        }
      };
      DataGrid.generateColumns = (row) => {
        return Object.getOwnPropertyNames(row).map((property, index) => {
          return {
            columnDataKey: property,
            gridColumn: `${index}`
          };
        });
      };
      __decorate([
        attr({ attribute: "no-tabbing", mode: "boolean" })
      ], DataGrid.prototype, "noTabbing", void 0);
      __decorate([
        attr({ attribute: "generate-header" })
      ], DataGrid.prototype, "generateHeader", void 0);
      __decorate([
        attr({ attribute: "grid-template-columns" })
      ], DataGrid.prototype, "gridTemplateColumns", void 0);
      __decorate([
        observable
      ], DataGrid.prototype, "rowsData", void 0);
      __decorate([
        observable
      ], DataGrid.prototype, "columnDefinitions", void 0);
      __decorate([
        observable
      ], DataGrid.prototype, "rowItemTemplate", void 0);
      __decorate([
        observable
      ], DataGrid.prototype, "cellItemTemplate", void 0);
      __decorate([
        observable
      ], DataGrid.prototype, "headerCellItemTemplate", void 0);
      __decorate([
        observable
      ], DataGrid.prototype, "focusRowIndex", void 0);
      __decorate([
        observable
      ], DataGrid.prototype, "focusColumnIndex", void 0);
      __decorate([
        observable
      ], DataGrid.prototype, "defaultRowItemTemplate", void 0);
      __decorate([
        observable
      ], DataGrid.prototype, "rowElementTag", void 0);
      __decorate([
        observable
      ], DataGrid.prototype, "rowElements", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid-cell.js
  var defaultCellContentsTemplate, defaultHeaderCellContentsTemplate, DataGridCell;
  var init_data_grid_cell = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid-cell.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_foundation_element();
      init_data_grid_options();
      defaultCellContentsTemplate = html`
    <template>
        ${(x) => x.rowData === null || x.columnDefinition === null || x.columnDefinition.columnDataKey === null ? null : x.rowData[x.columnDefinition.columnDataKey]}
    </template>
`;
      defaultHeaderCellContentsTemplate = html`
    <template>
        ${(x) => x.columnDefinition === null ? null : x.columnDefinition.title === void 0 ? x.columnDefinition.columnDataKey : x.columnDefinition.title}
    </template>
`;
      DataGridCell = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.cellType = DataGridCellTypes.default;
          this.rowData = null;
          this.columnDefinition = null;
          this.isActiveCell = false;
          this.customCellView = null;
          this.updateCellStyle = () => {
            this.style.gridColumn = this.gridColumn;
          };
        }
        cellTypeChanged() {
          if (this.$fastController.isConnected) {
            this.updateCellView();
          }
        }
        gridColumnChanged() {
          if (this.$fastController.isConnected) {
            this.updateCellStyle();
          }
        }
        columnDefinitionChanged(oldValue, newValue) {
          if (this.$fastController.isConnected) {
            this.updateCellView();
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          var _a;
          super.connectedCallback();
          this.addEventListener(eventFocusIn, this.handleFocusin);
          this.addEventListener(eventFocusOut, this.handleFocusout);
          this.addEventListener(eventKeyDown, this.handleKeydown);
          this.style.gridColumn = `${((_a = this.columnDefinition) === null || _a === void 0 ? void 0 : _a.gridColumn) === void 0 ? 0 : this.columnDefinition.gridColumn}`;
          this.updateCellView();
          this.updateCellStyle();
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          super.disconnectedCallback();
          this.removeEventListener(eventFocusIn, this.handleFocusin);
          this.removeEventListener(eventFocusOut, this.handleFocusout);
          this.removeEventListener(eventKeyDown, this.handleKeydown);
          this.disconnectCellView();
        }
        handleFocusin(e) {
          if (this.isActiveCell) {
            return;
          }
          this.isActiveCell = true;
          switch (this.cellType) {
            case DataGridCellTypes.columnHeader:
              if (this.columnDefinition !== null && this.columnDefinition.headerCellInternalFocusQueue !== true && typeof this.columnDefinition.headerCellFocusTargetCallback === "function") {
                const focusTarget = this.columnDefinition.headerCellFocusTargetCallback(this);
                if (focusTarget !== null) {
                  focusTarget.focus();
                }
              }
              break;
            default:
              if (this.columnDefinition !== null && this.columnDefinition.cellInternalFocusQueue !== true && typeof this.columnDefinition.cellFocusTargetCallback === "function") {
                const focusTarget = this.columnDefinition.cellFocusTargetCallback(this);
                if (focusTarget !== null) {
                  focusTarget.focus();
                }
              }
              break;
          }
          this.$emit("cell-focused", this);
        }
        handleFocusout(e) {
          if (this !== document.activeElement && !this.contains(document.activeElement)) {
            this.isActiveCell = false;
          }
        }
        handleKeydown(e) {
          if (e.defaultPrevented || this.columnDefinition === null || this.cellType === DataGridCellTypes.default && this.columnDefinition.cellInternalFocusQueue !== true || this.cellType === DataGridCellTypes.columnHeader && this.columnDefinition.headerCellInternalFocusQueue !== true) {
            return;
          }
          switch (e.key) {
            case keyEnter:
            case keyFunction2:
              if (this.contains(document.activeElement) && document.activeElement !== this) {
                return;
              }
              switch (this.cellType) {
                case DataGridCellTypes.columnHeader:
                  if (this.columnDefinition.headerCellFocusTargetCallback !== void 0) {
                    const focusTarget = this.columnDefinition.headerCellFocusTargetCallback(this);
                    if (focusTarget !== null) {
                      focusTarget.focus();
                    }
                    e.preventDefault();
                  }
                  break;
                default:
                  if (this.columnDefinition.cellFocusTargetCallback !== void 0) {
                    const focusTarget = this.columnDefinition.cellFocusTargetCallback(this);
                    if (focusTarget !== null) {
                      focusTarget.focus();
                    }
                    e.preventDefault();
                  }
                  break;
              }
              break;
            case keyEscape:
              if (this.contains(document.activeElement) && document.activeElement !== this) {
                this.focus();
                e.preventDefault();
              }
              break;
          }
        }
        updateCellView() {
          this.disconnectCellView();
          if (this.columnDefinition === null) {
            return;
          }
          switch (this.cellType) {
            case DataGridCellTypes.columnHeader:
              if (this.columnDefinition.headerCellTemplate !== void 0) {
                this.customCellView = this.columnDefinition.headerCellTemplate.render(this, this);
              } else {
                this.customCellView = defaultHeaderCellContentsTemplate.render(this, this);
              }
              break;
            case void 0:
            case DataGridCellTypes.rowHeader:
            case DataGridCellTypes.default:
              if (this.columnDefinition.cellTemplate !== void 0) {
                this.customCellView = this.columnDefinition.cellTemplate.render(this, this);
              } else {
                this.customCellView = defaultCellContentsTemplate.render(this, this);
              }
              break;
          }
        }
        disconnectCellView() {
          if (this.customCellView !== null) {
            this.customCellView.dispose();
            this.customCellView = null;
          }
        }
      };
      __decorate([
        attr({ attribute: "cell-type" })
      ], DataGridCell.prototype, "cellType", void 0);
      __decorate([
        attr({ attribute: "grid-column" })
      ], DataGridCell.prototype, "gridColumn", void 0);
      __decorate([
        observable
      ], DataGridCell.prototype, "rowData", void 0);
      __decorate([
        observable
      ], DataGridCell.prototype, "columnDefinition", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid-row.template.js
  function createCellItemTemplate(context) {
    const cellTag = context.tagFor(DataGridCell);
    return html`
    <${cellTag}
        cell-type="${(x) => x.isRowHeader ? "rowheader" : void 0}"
        grid-column="${(x, c) => c.index + 1}"
        :rowData="${(x, c) => c.parent.rowData}"
        :columnDefinition="${(x) => x}"
    ></${cellTag}>
`;
  }
  function createHeaderCellItemTemplate(context) {
    const cellTag = context.tagFor(DataGridCell);
    return html`
    <${cellTag}
        cell-type="columnheader"
        grid-column="${(x, c) => c.index + 1}"
        :columnDefinition="${(x) => x}"
    ></${cellTag}>
`;
  }
  var dataGridRowTemplate;
  var init_data_grid_row_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid-row.template.js"() {
      init_esm();
      init_data_grid_cell();
      dataGridRowTemplate = (context, definition) => {
        const cellItemTemplate = createCellItemTemplate(context);
        const headerCellItemTemplate = createHeaderCellItemTemplate(context);
        return html`
        <template
            role="row"
            class="${(x) => x.rowType !== "default" ? x.rowType : ""}"
            :defaultCellItemTemplate="${cellItemTemplate}"
            :defaultHeaderCellItemTemplate="${headerCellItemTemplate}"
            ${children({
          property: "cellElements",
          filter: elements('[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')
        })}
        >
            <slot ${slotted("slottedCellElements")}></slot>
        </template>
    `;
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid-cell.template.js
  var dataGridCellTemplate;
  var init_data_grid_cell_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/data-grid/data-grid-cell.template.js"() {
      init_esm();
      dataGridCellTemplate = (context, definition) => {
        return html`
        <template
            tabindex="-1"
            role="${(x) => !x.cellType || x.cellType === "default" ? "gridcell" : x.cellType}"
            class="
            ${(x) => x.cellType === "columnheader" ? "column-header" : x.cellType === "rowheader" ? "row-header" : ""}
            "
        >
            <slot></slot>
        </template>
    `;
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/data-grid/index.js
  var init_data_grid2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/data-grid/index.js"() {
      init_data_grid_template();
      init_data_grid();
      init_data_grid_row_template();
      init_data_grid_row();
      init_data_grid_cell_template();
      init_data_grid_cell();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/calendar/calendar.template.js
  var CalendarTitleTemplate;
  var init_calendar_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/calendar/calendar.template.js"() {
      init_esm();
      CalendarTitleTemplate = html`
    <div
        class="title"
        part="title"
        aria-label="${(x) => x.dateFormatter.getDate(`${x.month}-2-${x.year}`, {
        month: "long",
        year: "numeric"
      })}"
    >
        <span part="month">
            ${(x) => x.dateFormatter.getMonth(x.month)}
        </span>
        <span part="year">${(x) => x.dateFormatter.getYear(x.year)}</span>
    </div>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/calendar/index.js
  var init_calendar2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/calendar/index.js"() {
      init_calendar();
      init_calendar_template();
      init_date_formatter();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/card/card.template.js
  var init_card_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/card/card.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/card/card.js
  var init_card = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/card/card.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/card/index.js
  var init_card2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/card/index.js"() {
      init_card_template();
      init_card();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/checkbox/checkbox.template.js
  var checkboxTemplate;
  var init_checkbox_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/checkbox/checkbox.template.js"() {
      init_esm();
      checkboxTemplate = (context, definition) => html`
    <template
        role="checkbox"
        aria-checked="${(x) => x.checked}"
        aria-required="${(x) => x.required}"
        aria-disabled="${(x) => x.disabled}"
        aria-readonly="${(x) => x.readOnly}"
        tabindex="${(x) => x.disabled ? null : 0}"
        @keypress="${(x, c) => x.keypressHandler(c.event)}"
        @click="${(x, c) => x.clickHandler(c.event)}"
        class="${(x) => x.readOnly ? "readonly" : ""} ${(x) => x.checked ? "checked" : ""} ${(x) => x.indeterminate ? "indeterminate" : ""}"
    >
        <div part="control" class="control">
            <slot name="checked-indicator">
                ${definition.checkedIndicator || ""}
            </slot>
            <slot name="indeterminate-indicator">
                ${definition.indeterminateIndicator || ""}
            </slot>
        </div>
        <label
            part="label"
            class="${(x) => x.defaultSlottedNodes && x.defaultSlottedNodes.length ? "label" : "label label__hidden"}"
        >
            <slot ${slotted("defaultSlottedNodes")}></slot>
        </label>
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/checkbox/checkbox.form-associated.js
  var _Checkbox, FormAssociatedCheckbox;
  var init_checkbox_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/checkbox/checkbox.form-associated.js"() {
      init_form_associated();
      init_foundation_element();
      _Checkbox = class extends FoundationElement {
      };
      FormAssociatedCheckbox = class extends CheckableFormAssociated(_Checkbox) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("input");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/checkbox/checkbox.js
  var Checkbox;
  var init_checkbox = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/checkbox/checkbox.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_checkbox_form_associated();
      Checkbox = class extends FormAssociatedCheckbox {
        constructor() {
          super();
          this.initialValue = "on";
          this.indeterminate = false;
          this.keypressHandler = (e) => {
            if (this.readOnly) {
              return;
            }
            switch (e.key) {
              case keySpace:
                if (this.indeterminate) {
                  this.indeterminate = false;
                }
                this.checked = !this.checked;
                break;
            }
          };
          this.clickHandler = (e) => {
            if (!this.disabled && !this.readOnly) {
              if (this.indeterminate) {
                this.indeterminate = false;
              }
              this.checked = !this.checked;
            }
          };
          this.proxy.setAttribute("type", "checkbox");
        }
        readOnlyChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.readOnly = this.readOnly;
          }
        }
      };
      __decorate([
        attr({ attribute: "readonly", mode: "boolean" })
      ], Checkbox.prototype, "readOnly", void 0);
      __decorate([
        observable
      ], Checkbox.prototype, "defaultSlottedNodes", void 0);
      __decorate([
        observable
      ], Checkbox.prototype, "indeterminate", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/checkbox/index.js
  var init_checkbox2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/checkbox/index.js"() {
      init_checkbox_template();
      init_checkbox();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/listbox-option/listbox-option.js
  function isListboxOption(el) {
    return isHTMLElement(el) && (el.getAttribute("role") === "option" || el instanceof HTMLOptionElement);
  }
  var ListboxOption, DelegatesARIAListboxOption;
  var init_listbox_option = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/listbox-option/listbox-option.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_foundation_element();
      init_aria_global();
      init_start_end();
      init_apply_mixins();
      ListboxOption = class extends FoundationElement {
        constructor(text, value, defaultSelected, selected) {
          super();
          this.defaultSelected = false;
          this.dirtySelected = false;
          this.selected = this.defaultSelected;
          this.dirtyValue = false;
          if (text) {
            this.textContent = text;
          }
          if (value) {
            this.initialValue = value;
          }
          if (defaultSelected) {
            this.defaultSelected = defaultSelected;
          }
          if (selected) {
            this.selected = selected;
          }
          this.proxy = new Option(`${this.textContent}`, this.initialValue, this.defaultSelected, this.selected);
          this.proxy.disabled = this.disabled;
        }
        /**
         * Updates the ariaChecked property when the checked property changes.
         *
         * @param prev - the previous checked value
         * @param next - the current checked value
         *
         * @public
         */
        checkedChanged(prev, next) {
          if (typeof next === "boolean") {
            this.ariaChecked = next ? "true" : "false";
            return;
          }
          this.ariaChecked = null;
        }
        /**
         * Updates the proxy's text content when the default slot changes.
         * @param prev - the previous content value
         * @param next - the current content value
         *
         * @internal
         */
        contentChanged(prev, next) {
          if (this.proxy instanceof HTMLOptionElement) {
            this.proxy.textContent = this.textContent;
          }
          this.$emit("contentchange", null, { bubbles: true });
        }
        defaultSelectedChanged() {
          if (!this.dirtySelected) {
            this.selected = this.defaultSelected;
            if (this.proxy instanceof HTMLOptionElement) {
              this.proxy.selected = this.defaultSelected;
            }
          }
        }
        disabledChanged(prev, next) {
          this.ariaDisabled = this.disabled ? "true" : "false";
          if (this.proxy instanceof HTMLOptionElement) {
            this.proxy.disabled = this.disabled;
          }
        }
        selectedAttributeChanged() {
          this.defaultSelected = this.selectedAttribute;
          if (this.proxy instanceof HTMLOptionElement) {
            this.proxy.defaultSelected = this.defaultSelected;
          }
        }
        selectedChanged() {
          this.ariaSelected = this.selected ? "true" : "false";
          if (!this.dirtySelected) {
            this.dirtySelected = true;
          }
          if (this.proxy instanceof HTMLOptionElement) {
            this.proxy.selected = this.selected;
          }
        }
        initialValueChanged(previous, next) {
          if (!this.dirtyValue) {
            this.value = this.initialValue;
            this.dirtyValue = false;
          }
        }
        get label() {
          var _a;
          return (_a = this.value) !== null && _a !== void 0 ? _a : this.text;
        }
        get text() {
          var _a, _b;
          return (_b = (_a = this.textContent) === null || _a === void 0 ? void 0 : _a.replace(/\s+/g, " ").trim()) !== null && _b !== void 0 ? _b : "";
        }
        set value(next) {
          const newValue = `${next !== null && next !== void 0 ? next : ""}`;
          this._value = newValue;
          this.dirtyValue = true;
          if (this.proxy instanceof HTMLOptionElement) {
            this.proxy.value = newValue;
          }
          Observable.notify(this, "value");
        }
        get value() {
          var _a;
          Observable.track(this, "value");
          return (_a = this._value) !== null && _a !== void 0 ? _a : this.text;
        }
        get form() {
          return this.proxy ? this.proxy.form : null;
        }
      };
      __decorate([
        observable
      ], ListboxOption.prototype, "checked", void 0);
      __decorate([
        observable
      ], ListboxOption.prototype, "content", void 0);
      __decorate([
        observable
      ], ListboxOption.prototype, "defaultSelected", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], ListboxOption.prototype, "disabled", void 0);
      __decorate([
        attr({ attribute: "selected", mode: "boolean" })
      ], ListboxOption.prototype, "selectedAttribute", void 0);
      __decorate([
        observable
      ], ListboxOption.prototype, "selected", void 0);
      __decorate([
        attr({ attribute: "value", mode: "fromView" })
      ], ListboxOption.prototype, "initialValue", void 0);
      DelegatesARIAListboxOption = class {
      };
      __decorate([
        observable
      ], DelegatesARIAListboxOption.prototype, "ariaChecked", void 0);
      __decorate([
        observable
      ], DelegatesARIAListboxOption.prototype, "ariaPosInSet", void 0);
      __decorate([
        observable
      ], DelegatesARIAListboxOption.prototype, "ariaSelected", void 0);
      __decorate([
        observable
      ], DelegatesARIAListboxOption.prototype, "ariaSetSize", void 0);
      applyMixins(DelegatesARIAListboxOption, ARIAGlobalStatesAndProperties);
      applyMixins(ListboxOption, StartEnd, DelegatesARIAListboxOption);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/listbox/listbox.js
  var Listbox, DelegatesARIAListbox;
  var init_listbox = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/listbox/listbox.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_foundation_element();
      init_listbox_option();
      init_aria_global();
      init_apply_mixins();
      Listbox = class _Listbox extends FoundationElement {
        constructor() {
          super(...arguments);
          this._options = [];
          this.selectedIndex = -1;
          this.selectedOptions = [];
          this.shouldSkipFocus = false;
          this.typeaheadBuffer = "";
          this.typeaheadExpired = true;
          this.typeaheadTimeout = -1;
        }
        /**
         * The first selected option.
         *
         * @internal
         */
        get firstSelectedOption() {
          var _a;
          return (_a = this.selectedOptions[0]) !== null && _a !== void 0 ? _a : null;
        }
        /**
         * Returns true if there is one or more selectable option.
         *
         * @internal
         */
        get hasSelectableOptions() {
          return this.options.length > 0 && !this.options.every((o) => o.disabled);
        }
        /**
         * The number of options.
         *
         * @public
         */
        get length() {
          var _a, _b;
          return (_b = (_a = this.options) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0;
        }
        /**
         * The list of options.
         *
         * @public
         */
        get options() {
          Observable.track(this, "options");
          return this._options;
        }
        set options(value) {
          this._options = value;
          Observable.notify(this, "options");
        }
        /**
         * Flag for the typeahead timeout expiration.
         *
         * @deprecated use `Listbox.typeaheadExpired`
         * @internal
         */
        get typeAheadExpired() {
          return this.typeaheadExpired;
        }
        set typeAheadExpired(value) {
          this.typeaheadExpired = value;
        }
        /**
         * Handle click events for listbox options.
         *
         * @internal
         */
        clickHandler(e) {
          const captured = e.target.closest(`option,[role=option]`);
          if (captured && !captured.disabled) {
            this.selectedIndex = this.options.indexOf(captured);
            return true;
          }
        }
        /**
         * Ensures that the provided option is focused and scrolled into view.
         *
         * @param optionToFocus - The option to focus
         * @internal
         */
        focusAndScrollOptionIntoView(optionToFocus = this.firstSelectedOption) {
          if (this.contains(document.activeElement) && optionToFocus !== null) {
            optionToFocus.focus();
            requestAnimationFrame(() => {
              optionToFocus.scrollIntoView({ block: "nearest" });
            });
          }
        }
        /**
         * Handles `focusin` actions for the component. When the component receives focus,
         * the list of selected options is refreshed and the first selected option is scrolled
         * into view.
         *
         * @internal
         */
        focusinHandler(e) {
          if (!this.shouldSkipFocus && e.target === e.currentTarget) {
            this.setSelectedOptions();
            this.focusAndScrollOptionIntoView();
          }
          this.shouldSkipFocus = false;
        }
        /**
         * Returns the options which match the current typeahead buffer.
         *
         * @internal
         */
        getTypeaheadMatches() {
          const pattern = this.typeaheadBuffer.replace(/[.*+\-?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`^${pattern}`, "gi");
          return this.options.filter((o) => o.text.trim().match(re));
        }
        /**
         * Determines the index of the next option which is selectable, if any.
         *
         * @param prev - the previous selected index
         * @param next - the next index to select
         *
         * @internal
         */
        getSelectableIndex(prev = this.selectedIndex, next) {
          const direction = prev > next ? -1 : prev < next ? 1 : 0;
          const potentialDirection = prev + direction;
          let nextSelectableOption = null;
          switch (direction) {
            case -1: {
              nextSelectableOption = this.options.reduceRight((nextSelectableOption2, thisOption, index) => !nextSelectableOption2 && !thisOption.disabled && index < potentialDirection ? thisOption : nextSelectableOption2, nextSelectableOption);
              break;
            }
            case 1: {
              nextSelectableOption = this.options.reduce((nextSelectableOption2, thisOption, index) => !nextSelectableOption2 && !thisOption.disabled && index > potentialDirection ? thisOption : nextSelectableOption2, nextSelectableOption);
              break;
            }
          }
          return this.options.indexOf(nextSelectableOption);
        }
        /**
         * Handles external changes to child options.
         *
         * @param source - the source object
         * @param propertyName - the property
         *
         * @internal
         */
        handleChange(source, propertyName) {
          switch (propertyName) {
            case "selected": {
              if (_Listbox.slottedOptionFilter(source)) {
                this.selectedIndex = this.options.indexOf(source);
              }
              this.setSelectedOptions();
              break;
            }
          }
        }
        /**
         * Moves focus to an option whose label matches characters typed by the user.
         * Consecutive keystrokes are batched into a buffer of search text used
         * to match against the set of options.  If `TYPE_AHEAD_TIMEOUT_MS` passes
         * between consecutive keystrokes, the search restarts.
         *
         * @param key - the key to be evaluated
         *
         * @internal
         */
        handleTypeAhead(key) {
          if (this.typeaheadTimeout) {
            window.clearTimeout(this.typeaheadTimeout);
          }
          this.typeaheadTimeout = window.setTimeout(() => this.typeaheadExpired = true, _Listbox.TYPE_AHEAD_TIMEOUT_MS);
          if (key.length > 1) {
            return;
          }
          this.typeaheadBuffer = `${this.typeaheadExpired ? "" : this.typeaheadBuffer}${key}`;
        }
        /**
         * Handles `keydown` actions for listbox navigation and typeahead.
         *
         * @internal
         */
        keydownHandler(e) {
          if (this.disabled) {
            return true;
          }
          this.shouldSkipFocus = false;
          const key = e.key;
          switch (key) {
            // Select the first available option
            case keyHome: {
              if (!e.shiftKey) {
                e.preventDefault();
                this.selectFirstOption();
              }
              break;
            }
            // Select the next selectable option
            case keyArrowDown: {
              if (!e.shiftKey) {
                e.preventDefault();
                this.selectNextOption();
              }
              break;
            }
            // Select the previous selectable option
            case keyArrowUp: {
              if (!e.shiftKey) {
                e.preventDefault();
                this.selectPreviousOption();
              }
              break;
            }
            // Select the last available option
            case keyEnd: {
              e.preventDefault();
              this.selectLastOption();
              break;
            }
            case keyTab: {
              this.focusAndScrollOptionIntoView();
              return true;
            }
            case keyEnter:
            case keyEscape: {
              return true;
            }
            case keySpace: {
              if (this.typeaheadExpired) {
                return true;
              }
            }
            // Send key to Typeahead handler
            default: {
              if (key.length === 1) {
                this.handleTypeAhead(`${key}`);
              }
              return true;
            }
          }
        }
        /**
         * Prevents `focusin` events from firing before `click` events when the
         * element is unfocused.
         *
         * @internal
         */
        mousedownHandler(e) {
          this.shouldSkipFocus = !this.contains(document.activeElement);
          return true;
        }
        /**
         * Switches between single-selection and multi-selection mode.
         *
         * @param prev - the previous value of the `multiple` attribute
         * @param next - the next value of the `multiple` attribute
         *
         * @internal
         */
        multipleChanged(prev, next) {
          this.ariaMultiSelectable = next ? "true" : null;
        }
        /**
         * Updates the list of selected options when the `selectedIndex` changes.
         *
         * @param prev - the previous selected index value
         * @param next - the current selected index value
         *
         * @internal
         */
        selectedIndexChanged(prev, next) {
          var _a;
          if (!this.hasSelectableOptions) {
            this.selectedIndex = -1;
            return;
          }
          if (((_a = this.options[this.selectedIndex]) === null || _a === void 0 ? void 0 : _a.disabled) && typeof prev === "number") {
            const selectableIndex = this.getSelectableIndex(prev, next);
            const newNext = selectableIndex > -1 ? selectableIndex : prev;
            this.selectedIndex = newNext;
            if (next === newNext) {
              this.selectedIndexChanged(next, newNext);
            }
            return;
          }
          this.setSelectedOptions();
        }
        /**
         * Updates the selectedness of each option when the list of selected options changes.
         *
         * @param prev - the previous list of selected options
         * @param next - the current list of selected options
         *
         * @internal
         */
        selectedOptionsChanged(prev, next) {
          var _a;
          const filteredNext = next.filter(_Listbox.slottedOptionFilter);
          (_a = this.options) === null || _a === void 0 ? void 0 : _a.forEach((o) => {
            const notifier = Observable.getNotifier(o);
            notifier.unsubscribe(this, "selected");
            o.selected = filteredNext.includes(o);
            notifier.subscribe(this, "selected");
          });
        }
        /**
         * Moves focus to the first selectable option.
         *
         * @public
         */
        selectFirstOption() {
          var _a, _b;
          if (!this.disabled) {
            this.selectedIndex = (_b = (_a = this.options) === null || _a === void 0 ? void 0 : _a.findIndex((o) => !o.disabled)) !== null && _b !== void 0 ? _b : -1;
          }
        }
        /**
         * Moves focus to the last selectable option.
         *
         * @internal
         */
        selectLastOption() {
          if (!this.disabled) {
            this.selectedIndex = findLastIndex(this.options, (o) => !o.disabled);
          }
        }
        /**
         * Moves focus to the next selectable option.
         *
         * @internal
         */
        selectNextOption() {
          if (!this.disabled && this.selectedIndex < this.options.length - 1) {
            this.selectedIndex += 1;
          }
        }
        /**
         * Moves focus to the previous selectable option.
         *
         * @internal
         */
        selectPreviousOption() {
          if (!this.disabled && this.selectedIndex > 0) {
            this.selectedIndex = this.selectedIndex - 1;
          }
        }
        /**
         * Updates the selected index to match the first selected option.
         *
         * @internal
         */
        setDefaultSelectedOption() {
          var _a, _b;
          this.selectedIndex = (_b = (_a = this.options) === null || _a === void 0 ? void 0 : _a.findIndex((el) => el.defaultSelected)) !== null && _b !== void 0 ? _b : -1;
        }
        /**
         * Sets an option as selected and gives it focus.
         *
         * @public
         */
        setSelectedOptions() {
          var _a, _b, _c;
          if ((_a = this.options) === null || _a === void 0 ? void 0 : _a.length) {
            this.selectedOptions = [this.options[this.selectedIndex]];
            this.ariaActiveDescendant = (_c = (_b = this.firstSelectedOption) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : "";
            this.focusAndScrollOptionIntoView();
          }
        }
        /**
         * Updates the list of options and resets the selected option when the slotted option content changes.
         *
         * @param prev - the previous list of slotted options
         * @param next - the current list of slotted options
         *
         * @internal
         */
        slottedOptionsChanged(prev, next) {
          this.options = next.reduce((options, item) => {
            if (isListboxOption(item)) {
              options.push(item);
            }
            return options;
          }, []);
          const setSize = `${this.options.length}`;
          this.options.forEach((option, index) => {
            if (!option.id) {
              option.id = uniqueId("option-");
            }
            option.ariaPosInSet = `${index + 1}`;
            option.ariaSetSize = setSize;
          });
          if (this.$fastController.isConnected) {
            this.setSelectedOptions();
            this.setDefaultSelectedOption();
          }
        }
        /**
         * Updates the filtered list of options when the typeahead buffer changes.
         *
         * @param prev - the previous typeahead buffer value
         * @param next - the current typeahead buffer value
         *
         * @internal
         */
        typeaheadBufferChanged(prev, next) {
          if (this.$fastController.isConnected) {
            const typeaheadMatches = this.getTypeaheadMatches();
            if (typeaheadMatches.length) {
              const selectedIndex = this.options.indexOf(typeaheadMatches[0]);
              if (selectedIndex > -1) {
                this.selectedIndex = selectedIndex;
              }
            }
            this.typeaheadExpired = false;
          }
        }
      };
      Listbox.slottedOptionFilter = (n) => isListboxOption(n) && !n.hidden;
      Listbox.TYPE_AHEAD_TIMEOUT_MS = 1e3;
      __decorate([
        attr({ mode: "boolean" })
      ], Listbox.prototype, "disabled", void 0);
      __decorate([
        observable
      ], Listbox.prototype, "selectedIndex", void 0);
      __decorate([
        observable
      ], Listbox.prototype, "selectedOptions", void 0);
      __decorate([
        observable
      ], Listbox.prototype, "slottedOptions", void 0);
      __decorate([
        observable
      ], Listbox.prototype, "typeaheadBuffer", void 0);
      DelegatesARIAListbox = class {
      };
      __decorate([
        observable
      ], DelegatesARIAListbox.prototype, "ariaActiveDescendant", void 0);
      __decorate([
        observable
      ], DelegatesARIAListbox.prototype, "ariaDisabled", void 0);
      __decorate([
        observable
      ], DelegatesARIAListbox.prototype, "ariaExpanded", void 0);
      __decorate([
        observable
      ], DelegatesARIAListbox.prototype, "ariaMultiSelectable", void 0);
      applyMixins(DelegatesARIAListbox, ARIAGlobalStatesAndProperties);
      applyMixins(Listbox, DelegatesARIAListbox);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/select/select.options.js
  var SelectPosition;
  var init_select_options = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/select/select.options.js"() {
      SelectPosition = {
        above: "above",
        below: "below"
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/combobox/combobox.form-associated.js
  var _Combobox, FormAssociatedCombobox;
  var init_combobox_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/combobox/combobox.form-associated.js"() {
      init_form_associated();
      init_listbox();
      _Combobox = class extends Listbox {
      };
      FormAssociatedCombobox = class extends FormAssociated(_Combobox) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("input");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/combobox/combobox.options.js
  var ComboboxAutocomplete;
  var init_combobox_options = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/combobox/combobox.options.js"() {
      ComboboxAutocomplete = {
        inline: "inline",
        list: "list",
        both: "both",
        none: "none"
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/combobox/combobox.js
  var Combobox, DelegatesARIACombobox;
  var init_combobox = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/combobox/combobox.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_listbox();
      init_start_end();
      init_select_options();
      init_apply_mixins();
      init_combobox_form_associated();
      init_combobox_options();
      Combobox = class extends FormAssociatedCombobox {
        constructor() {
          super(...arguments);
          this._value = "";
          this.filteredOptions = [];
          this.filter = "";
          this.forcedPosition = false;
          this.listboxId = uniqueId("listbox-");
          this.maxHeight = 0;
          this.open = false;
        }
        /**
         * Reset the element to its first selectable option when its parent form is reset.
         *
         * @internal
         */
        formResetCallback() {
          super.formResetCallback();
          this.setDefaultSelectedOption();
          this.updateValue();
        }
        /** {@inheritDoc (FormAssociated:interface).validate} */
        validate() {
          super.validate(this.control);
        }
        get isAutocompleteInline() {
          return this.autocomplete === ComboboxAutocomplete.inline || this.isAutocompleteBoth;
        }
        get isAutocompleteList() {
          return this.autocomplete === ComboboxAutocomplete.list || this.isAutocompleteBoth;
        }
        get isAutocompleteBoth() {
          return this.autocomplete === ComboboxAutocomplete.both;
        }
        /**
         * Sets focus and synchronize ARIA attributes when the open property changes.
         *
         * @param prev - the previous open value
         * @param next - the current open value
         *
         * @internal
         */
        openChanged() {
          if (this.open) {
            this.ariaControls = this.listboxId;
            this.ariaExpanded = "true";
            this.setPositioning();
            this.focusAndScrollOptionIntoView();
            DOM.queueUpdate(() => this.focus());
            return;
          }
          this.ariaControls = "";
          this.ariaExpanded = "false";
        }
        /**
         * The list of options.
         *
         * @public
         * @remarks
         * Overrides `Listbox.options`.
         */
        get options() {
          Observable.track(this, "options");
          return this.filteredOptions.length ? this.filteredOptions : this._options;
        }
        set options(value) {
          this._options = value;
          Observable.notify(this, "options");
        }
        /**
         * Updates the placeholder on the proxy element.
         * @internal
         */
        placeholderChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.placeholder = this.placeholder;
          }
        }
        positionChanged(prev, next) {
          this.positionAttribute = next;
          this.setPositioning();
        }
        /**
         * The value property.
         *
         * @public
         */
        get value() {
          Observable.track(this, "value");
          return this._value;
        }
        set value(next) {
          var _a, _b, _c;
          const prev = `${this._value}`;
          if (this.$fastController.isConnected && this.options) {
            const selectedIndex = this.options.findIndex((el) => el.text.toLowerCase() === next.toLowerCase());
            const prevSelectedValue = (_a = this.options[this.selectedIndex]) === null || _a === void 0 ? void 0 : _a.text;
            const nextSelectedValue = (_b = this.options[selectedIndex]) === null || _b === void 0 ? void 0 : _b.text;
            this.selectedIndex = prevSelectedValue !== nextSelectedValue ? selectedIndex : this.selectedIndex;
            next = ((_c = this.firstSelectedOption) === null || _c === void 0 ? void 0 : _c.text) || next;
          }
          if (prev !== next) {
            this._value = next;
            super.valueChanged(prev, next);
            Observable.notify(this, "value");
          }
        }
        /**
         * Handle opening and closing the listbox when the combobox is clicked.
         *
         * @param e - the mouse event
         * @internal
         */
        clickHandler(e) {
          const captured = e.target.closest(`option,[role=option]`);
          if (this.disabled || (captured === null || captured === void 0 ? void 0 : captured.disabled)) {
            return;
          }
          if (this.open) {
            if (e.composedPath()[0] === this.control) {
              return;
            }
            if (captured) {
              this.selectedOptions = [captured];
              this.control.value = captured.text;
              this.clearSelectionRange();
              this.updateValue(true);
            }
          }
          this.open = !this.open;
          if (this.open) {
            this.control.focus();
          }
          return true;
        }
        connectedCallback() {
          super.connectedCallback();
          this.forcedPosition = !!this.positionAttribute;
          if (this.value) {
            this.initialValue = this.value;
          }
        }
        /**
         * Synchronize the `aria-disabled` property when the `disabled` property changes.
         *
         * @param prev - The previous disabled value
         * @param next - The next disabled value
         *
         * @internal
         */
        disabledChanged(prev, next) {
          if (super.disabledChanged) {
            super.disabledChanged(prev, next);
          }
          this.ariaDisabled = this.disabled ? "true" : "false";
        }
        /**
         * Filter available options by text value.
         *
         * @public
         */
        filterOptions() {
          if (!this.autocomplete || this.autocomplete === ComboboxAutocomplete.none) {
            this.filter = "";
          }
          const filter = this.filter.toLowerCase();
          this.filteredOptions = this._options.filter((o) => o.text.toLowerCase().startsWith(this.filter.toLowerCase()));
          if (this.isAutocompleteList) {
            if (!this.filteredOptions.length && !filter) {
              this.filteredOptions = this._options;
            }
            this._options.forEach((o) => {
              o.hidden = !this.filteredOptions.includes(o);
            });
          }
        }
        /**
         * Focus the control and scroll the first selected option into view.
         *
         * @internal
         * @remarks
         * Overrides: `Listbox.focusAndScrollOptionIntoView`
         */
        focusAndScrollOptionIntoView() {
          if (this.contains(document.activeElement)) {
            this.control.focus();
            if (this.firstSelectedOption) {
              requestAnimationFrame(() => {
                var _a;
                (_a = this.firstSelectedOption) === null || _a === void 0 ? void 0 : _a.scrollIntoView({ block: "nearest" });
              });
            }
          }
        }
        /**
         * Handle focus state when the element or its children lose focus.
         *
         * @param e - The focus event
         * @internal
         */
        focusoutHandler(e) {
          this.syncValue();
          if (!this.open) {
            return true;
          }
          const focusTarget = e.relatedTarget;
          if (this.isSameNode(focusTarget)) {
            this.focus();
            return;
          }
          if (!this.options || !this.options.includes(focusTarget)) {
            this.open = false;
          }
        }
        /**
         * Handle content changes on the control input.
         *
         * @param e - the input event
         * @internal
         */
        inputHandler(e) {
          this.filter = this.control.value;
          this.filterOptions();
          if (!this.isAutocompleteInline) {
            this.selectedIndex = this.options.map((option) => option.text).indexOf(this.control.value);
          }
          if (e.inputType.includes("deleteContent") || !this.filter.length) {
            return true;
          }
          if (this.isAutocompleteList && !this.open) {
            this.open = true;
          }
          if (this.isAutocompleteInline) {
            if (this.filteredOptions.length) {
              this.selectedOptions = [this.filteredOptions[0]];
              this.selectedIndex = this.options.indexOf(this.firstSelectedOption);
              this.setInlineSelection();
            } else {
              this.selectedIndex = -1;
            }
          }
          return;
        }
        /**
         * Handle keydown actions for listbox navigation.
         *
         * @param e - the keyboard event
         * @internal
         */
        keydownHandler(e) {
          const key = e.key;
          if (e.ctrlKey || e.shiftKey) {
            return true;
          }
          switch (key) {
            case "Enter": {
              this.syncValue();
              if (this.isAutocompleteInline) {
                this.filter = this.value;
              }
              this.open = false;
              this.clearSelectionRange();
              break;
            }
            case "Escape": {
              if (!this.isAutocompleteInline) {
                this.selectedIndex = -1;
              }
              if (this.open) {
                this.open = false;
                break;
              }
              this.value = "";
              this.control.value = "";
              this.filter = "";
              this.filterOptions();
              break;
            }
            case "Tab": {
              this.setInputToSelection();
              if (!this.open) {
                return true;
              }
              e.preventDefault();
              this.open = false;
              break;
            }
            case "ArrowUp":
            case "ArrowDown": {
              this.filterOptions();
              if (!this.open) {
                this.open = true;
                break;
              }
              if (this.filteredOptions.length > 0) {
                super.keydownHandler(e);
              }
              if (this.isAutocompleteInline) {
                this.setInlineSelection();
              }
              break;
            }
            default: {
              return true;
            }
          }
        }
        /**
         * Handle keyup actions for value input and text field manipulations.
         *
         * @param e - the keyboard event
         * @internal
         */
        keyupHandler(e) {
          const key = e.key;
          switch (key) {
            case "ArrowLeft":
            case "ArrowRight":
            case "Backspace":
            case "Delete":
            case "Home":
            case "End": {
              this.filter = this.control.value;
              this.selectedIndex = -1;
              this.filterOptions();
              break;
            }
          }
        }
        /**
         * Ensure that the selectedIndex is within the current allowable filtered range.
         *
         * @param prev - the previous selected index value
         * @param next - the current selected index value
         *
         * @internal
         */
        selectedIndexChanged(prev, next) {
          if (this.$fastController.isConnected) {
            next = limit(-1, this.options.length - 1, next);
            if (next !== this.selectedIndex) {
              this.selectedIndex = next;
              return;
            }
            super.selectedIndexChanged(prev, next);
          }
        }
        /**
         * Move focus to the previous selectable option.
         *
         * @internal
         * @remarks
         * Overrides `Listbox.selectPreviousOption`
         */
        selectPreviousOption() {
          if (!this.disabled && this.selectedIndex >= 0) {
            this.selectedIndex = this.selectedIndex - 1;
          }
        }
        /**
         * Set the default selected options at initialization or reset.
         *
         * @internal
         * @remarks
         * Overrides `Listbox.setDefaultSelectedOption`
         */
        setDefaultSelectedOption() {
          if (this.$fastController.isConnected && this.options) {
            const selectedIndex = this.options.findIndex((el) => el.getAttribute("selected") !== null || el.selected);
            this.selectedIndex = selectedIndex;
            if (!this.dirtyValue && this.firstSelectedOption) {
              this.value = this.firstSelectedOption.text;
            }
            this.setSelectedOptions();
          }
        }
        /**
         * Focus and set the content of the control based on the first selected option.
         *
         * @internal
         */
        setInputToSelection() {
          if (this.firstSelectedOption) {
            this.control.value = this.firstSelectedOption.text;
            this.control.focus();
          }
        }
        /**
         * Focus, set and select the content of the control based on the first selected option.
         *
         * @internal
         */
        setInlineSelection() {
          if (this.firstSelectedOption) {
            this.setInputToSelection();
            this.control.setSelectionRange(this.filter.length, this.control.value.length, "backward");
          }
        }
        /**
         * Determines if a value update should involve emitting a change event, then updates the value.
         *
         * @internal
         */
        syncValue() {
          var _a;
          const newValue = this.selectedIndex > -1 ? (_a = this.firstSelectedOption) === null || _a === void 0 ? void 0 : _a.text : this.control.value;
          this.updateValue(this.value !== newValue);
        }
        /**
         * Calculate and apply listbox positioning based on available viewport space.
         *
         * @param force - direction to force the listbox to display
         * @public
         */
        setPositioning() {
          const currentBox = this.getBoundingClientRect();
          const viewportHeight = window.innerHeight;
          const availableBottom = viewportHeight - currentBox.bottom;
          this.position = this.forcedPosition ? this.positionAttribute : currentBox.top > availableBottom ? SelectPosition.above : SelectPosition.below;
          this.positionAttribute = this.forcedPosition ? this.positionAttribute : this.position;
          this.maxHeight = this.position === SelectPosition.above ? ~~currentBox.top : ~~availableBottom;
        }
        /**
         * Ensure that the entire list of options is used when setting the selected property.
         *
         * @param prev - the previous list of selected options
         * @param next - the current list of selected options
         *
         * @internal
         * @remarks
         * Overrides: `Listbox.selectedOptionsChanged`
         */
        selectedOptionsChanged(prev, next) {
          if (this.$fastController.isConnected) {
            this._options.forEach((o) => {
              o.selected = next.includes(o);
            });
          }
        }
        /**
         * Synchronize the form-associated proxy and update the value property of the element.
         *
         * @param prev - the previous collection of slotted option elements
         * @param next - the next collection of slotted option elements
         *
         * @internal
         */
        slottedOptionsChanged(prev, next) {
          super.slottedOptionsChanged(prev, next);
          this.updateValue();
        }
        /**
         * Sets the value and to match the first selected option.
         *
         * @param shouldEmit - if true, the change event will be emitted
         *
         * @internal
         */
        updateValue(shouldEmit) {
          var _a;
          if (this.$fastController.isConnected) {
            this.value = ((_a = this.firstSelectedOption) === null || _a === void 0 ? void 0 : _a.text) || this.control.value;
            this.control.value = this.value;
          }
          if (shouldEmit) {
            this.$emit("change");
          }
        }
        /**
         * @internal
         */
        clearSelectionRange() {
          const controlValueLength = this.control.value.length;
          this.control.setSelectionRange(controlValueLength, controlValueLength);
        }
      };
      __decorate([
        attr({ attribute: "autocomplete", mode: "fromView" })
      ], Combobox.prototype, "autocomplete", void 0);
      __decorate([
        observable
      ], Combobox.prototype, "maxHeight", void 0);
      __decorate([
        attr({ attribute: "open", mode: "boolean" })
      ], Combobox.prototype, "open", void 0);
      __decorate([
        attr
      ], Combobox.prototype, "placeholder", void 0);
      __decorate([
        attr({ attribute: "position" })
      ], Combobox.prototype, "positionAttribute", void 0);
      __decorate([
        observable
      ], Combobox.prototype, "position", void 0);
      DelegatesARIACombobox = class {
      };
      __decorate([
        observable
      ], DelegatesARIACombobox.prototype, "ariaAutoComplete", void 0);
      __decorate([
        observable
      ], DelegatesARIACombobox.prototype, "ariaControls", void 0);
      applyMixins(DelegatesARIACombobox, DelegatesARIAListbox);
      applyMixins(Combobox, StartEnd, DelegatesARIACombobox);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/combobox/combobox.template.js
  var init_combobox_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/combobox/combobox.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/combobox/index.js
  var init_combobox2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/combobox/index.js"() {
      init_combobox();
      init_combobox_options();
      init_combobox_template();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/composed-parent.js
  function composedParent(element) {
    const parentNode = element.parentElement;
    if (parentNode) {
      return parentNode;
    } else {
      const rootNode = element.getRootNode();
      if (rootNode.host instanceof HTMLElement) {
        return rootNode.host;
      }
    }
    return null;
  }
  var init_composed_parent = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/composed-parent.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/composed-contains.js
  function composedContains(reference, test) {
    let current = test;
    while (current !== null) {
      if (current === reference) {
        return true;
      }
      current = composedParent(current);
    }
    return false;
  }
  var init_composed_contains = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/composed-contains.js"() {
      init_composed_parent();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/design-token/custom-property-manager.js
  function isFastElement(element) {
    return element instanceof FASTElement;
  }
  var defaultElement, QueuedStyleSheetTarget, ConstructableStyleSheetTarget, DocumentStyleSheetTarget, HeadStyleElementStyleSheetTarget, StyleElementStyleSheetTarget, ElementStyleSheetTarget, RootStyleSheetTarget, propertyTargetCache, propertyTargetCtor, PropertyTargetManager;
  var init_custom_property_manager = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/design-token/custom-property-manager.js"() {
      init_tslib_es6();
      init_esm();
      defaultElement = document.createElement("div");
      QueuedStyleSheetTarget = class {
        setProperty(name, value) {
          DOM.queueUpdate(() => this.target.setProperty(name, value));
        }
        removeProperty(name) {
          DOM.queueUpdate(() => this.target.removeProperty(name));
        }
      };
      ConstructableStyleSheetTarget = class extends QueuedStyleSheetTarget {
        constructor(source) {
          super();
          const sheet = new CSSStyleSheet();
          sheet[prependToAdoptedStyleSheetsSymbol] = true;
          this.target = sheet.cssRules[sheet.insertRule(":host{}")].style;
          source.$fastController.addStyles(ElementStyles.create([sheet]));
        }
      };
      DocumentStyleSheetTarget = class extends QueuedStyleSheetTarget {
        constructor() {
          super();
          const sheet = new CSSStyleSheet();
          this.target = sheet.cssRules[sheet.insertRule(":root{}")].style;
          document.adoptedStyleSheets = [
            ...document.adoptedStyleSheets,
            sheet
          ];
        }
      };
      HeadStyleElementStyleSheetTarget = class extends QueuedStyleSheetTarget {
        constructor() {
          super();
          this.style = document.createElement("style");
          document.head.appendChild(this.style);
          const { sheet } = this.style;
          if (sheet) {
            const index = sheet.insertRule(":root{}", sheet.cssRules.length);
            this.target = sheet.cssRules[index].style;
          }
        }
      };
      StyleElementStyleSheetTarget = class {
        constructor(target) {
          this.store = /* @__PURE__ */ new Map();
          this.target = null;
          const controller = target.$fastController;
          this.style = document.createElement("style");
          controller.addStyles(this.style);
          Observable.getNotifier(controller).subscribe(this, "isConnected");
          this.handleChange(controller, "isConnected");
        }
        targetChanged() {
          if (this.target !== null) {
            for (const [key, value] of this.store.entries()) {
              this.target.setProperty(key, value);
            }
          }
        }
        setProperty(name, value) {
          this.store.set(name, value);
          DOM.queueUpdate(() => {
            if (this.target !== null) {
              this.target.setProperty(name, value);
            }
          });
        }
        removeProperty(name) {
          this.store.delete(name);
          DOM.queueUpdate(() => {
            if (this.target !== null) {
              this.target.removeProperty(name);
            }
          });
        }
        handleChange(source, key) {
          const { sheet } = this.style;
          if (sheet) {
            const index = sheet.insertRule(":host{}", sheet.cssRules.length);
            this.target = sheet.cssRules[index].style;
          } else {
            this.target = null;
          }
        }
      };
      __decorate([
        observable
      ], StyleElementStyleSheetTarget.prototype, "target", void 0);
      ElementStyleSheetTarget = class {
        constructor(source) {
          this.target = source.style;
        }
        setProperty(name, value) {
          DOM.queueUpdate(() => this.target.setProperty(name, value));
        }
        removeProperty(name) {
          DOM.queueUpdate(() => this.target.removeProperty(name));
        }
      };
      RootStyleSheetTarget = class _RootStyleSheetTarget {
        setProperty(name, value) {
          _RootStyleSheetTarget.properties[name] = value;
          for (const target of _RootStyleSheetTarget.roots.values()) {
            PropertyTargetManager.getOrCreate(_RootStyleSheetTarget.normalizeRoot(target)).setProperty(name, value);
          }
        }
        removeProperty(name) {
          delete _RootStyleSheetTarget.properties[name];
          for (const target of _RootStyleSheetTarget.roots.values()) {
            PropertyTargetManager.getOrCreate(_RootStyleSheetTarget.normalizeRoot(target)).removeProperty(name);
          }
        }
        static registerRoot(root) {
          const { roots } = _RootStyleSheetTarget;
          if (!roots.has(root)) {
            roots.add(root);
            const target = PropertyTargetManager.getOrCreate(this.normalizeRoot(root));
            for (const key in _RootStyleSheetTarget.properties) {
              target.setProperty(key, _RootStyleSheetTarget.properties[key]);
            }
          }
        }
        static unregisterRoot(root) {
          const { roots } = _RootStyleSheetTarget;
          if (roots.has(root)) {
            roots.delete(root);
            const target = PropertyTargetManager.getOrCreate(_RootStyleSheetTarget.normalizeRoot(root));
            for (const key in _RootStyleSheetTarget.properties) {
              target.removeProperty(key);
            }
          }
        }
        /**
         * Returns the document when provided the default element,
         * otherwise is a no-op
         * @param root - the root to normalize
         */
        static normalizeRoot(root) {
          return root === defaultElement ? document : root;
        }
      };
      RootStyleSheetTarget.roots = /* @__PURE__ */ new Set();
      RootStyleSheetTarget.properties = {};
      propertyTargetCache = /* @__PURE__ */ new WeakMap();
      propertyTargetCtor = DOM.supportsAdoptedStyleSheets ? ConstructableStyleSheetTarget : StyleElementStyleSheetTarget;
      PropertyTargetManager = Object.freeze({
        getOrCreate(source) {
          if (propertyTargetCache.has(source)) {
            return propertyTargetCache.get(source);
          }
          let target;
          if (source === defaultElement) {
            target = new RootStyleSheetTarget();
          } else if (source instanceof Document) {
            target = DOM.supportsAdoptedStyleSheets ? new DocumentStyleSheetTarget() : new HeadStyleElementStyleSheetTarget();
          } else if (isFastElement(source)) {
            target = new propertyTargetCtor(source);
          } else {
            target = new ElementStyleSheetTarget(source);
          }
          propertyTargetCache.set(source, target);
          return target;
        }
      });
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/design-token/design-token.js
  function create(nameOrConfig) {
    return DesignTokenImpl.from(nameOrConfig);
  }
  var DesignTokenImpl, CustomPropertyReflector, DesignTokenBindingObserver, Store, nodeCache, childToParent, DesignTokenNode, DesignToken;
  var init_design_token = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/design-token/design-token.js"() {
      init_tslib_es6();
      init_esm();
      init_composed_parent();
      init_composed_contains();
      init_custom_property_manager();
      init_custom_property_manager();
      DesignTokenImpl = class _DesignTokenImpl extends CSSDirective {
        constructor(configuration) {
          super();
          this.subscribers = /* @__PURE__ */ new WeakMap();
          this._appliedTo = /* @__PURE__ */ new Set();
          this.name = configuration.name;
          if (configuration.cssCustomPropertyName !== null) {
            this.cssCustomProperty = `--${configuration.cssCustomPropertyName}`;
            this.cssVar = `var(${this.cssCustomProperty})`;
          }
          this.id = _DesignTokenImpl.uniqueId();
          _DesignTokenImpl.tokensById.set(this.id, this);
        }
        get appliedTo() {
          return [...this._appliedTo];
        }
        static from(nameOrConfig) {
          return new _DesignTokenImpl({
            name: typeof nameOrConfig === "string" ? nameOrConfig : nameOrConfig.name,
            cssCustomPropertyName: typeof nameOrConfig === "string" ? nameOrConfig : nameOrConfig.cssCustomPropertyName === void 0 ? nameOrConfig.name : nameOrConfig.cssCustomPropertyName
          });
        }
        static isCSSDesignToken(token) {
          return typeof token.cssCustomProperty === "string";
        }
        static isDerivedDesignTokenValue(value) {
          return typeof value === "function";
        }
        /**
         * Gets a token by ID. Returns undefined if the token was not found.
         * @param id - The ID of the token
         * @returns
         */
        static getTokenById(id) {
          return _DesignTokenImpl.tokensById.get(id);
        }
        getOrCreateSubscriberSet(target = this) {
          return this.subscribers.get(target) || this.subscribers.set(target, /* @__PURE__ */ new Set()) && this.subscribers.get(target);
        }
        createCSS() {
          return this.cssVar || "";
        }
        getValueFor(element) {
          const value = DesignTokenNode.getOrCreate(element).get(this);
          if (value !== void 0) {
            return value;
          }
          throw new Error(`Value could not be retrieved for token named "${this.name}". Ensure the value is set for ${element} or an ancestor of ${element}.`);
        }
        setValueFor(element, value) {
          this._appliedTo.add(element);
          if (value instanceof _DesignTokenImpl) {
            value = this.alias(value);
          }
          DesignTokenNode.getOrCreate(element).set(this, value);
          return this;
        }
        deleteValueFor(element) {
          this._appliedTo.delete(element);
          if (DesignTokenNode.existsFor(element)) {
            DesignTokenNode.getOrCreate(element).delete(this);
          }
          return this;
        }
        withDefault(value) {
          this.setValueFor(defaultElement, value);
          return this;
        }
        subscribe(subscriber, target) {
          const subscriberSet = this.getOrCreateSubscriberSet(target);
          if (target && !DesignTokenNode.existsFor(target)) {
            DesignTokenNode.getOrCreate(target);
          }
          if (!subscriberSet.has(subscriber)) {
            subscriberSet.add(subscriber);
          }
        }
        unsubscribe(subscriber, target) {
          const list = this.subscribers.get(target || this);
          if (list && list.has(subscriber)) {
            list.delete(subscriber);
          }
        }
        /**
         * Notifies subscribers that the value for an element has changed.
         * @param element - The element to emit a notification for
         */
        notify(element) {
          const record = Object.freeze({ token: this, target: element });
          if (this.subscribers.has(this)) {
            this.subscribers.get(this).forEach((sub) => sub.handleChange(record));
          }
          if (this.subscribers.has(element)) {
            this.subscribers.get(element).forEach((sub) => sub.handleChange(record));
          }
        }
        /**
         * Alias the token to the provided token.
         * @param token - the token to alias to
         */
        alias(token) {
          return ((target) => token.getValueFor(target));
        }
      };
      DesignTokenImpl.uniqueId = /* @__PURE__ */ (() => {
        let id = 0;
        return () => {
          id++;
          return id.toString(16);
        };
      })();
      DesignTokenImpl.tokensById = /* @__PURE__ */ new Map();
      CustomPropertyReflector = class {
        startReflection(token, target) {
          token.subscribe(this, target);
          this.handleChange({ token, target });
        }
        stopReflection(token, target) {
          token.unsubscribe(this, target);
          this.remove(token, target);
        }
        handleChange(record) {
          const { token, target } = record;
          this.add(token, target);
        }
        add(token, target) {
          PropertyTargetManager.getOrCreate(target).setProperty(token.cssCustomProperty, this.resolveCSSValue(DesignTokenNode.getOrCreate(target).get(token)));
        }
        remove(token, target) {
          PropertyTargetManager.getOrCreate(target).removeProperty(token.cssCustomProperty);
        }
        resolveCSSValue(value) {
          return value && typeof value.createCSS === "function" ? value.createCSS() : value;
        }
      };
      DesignTokenBindingObserver = class {
        constructor(source, token, node) {
          this.source = source;
          this.token = token;
          this.node = node;
          this.dependencies = /* @__PURE__ */ new Set();
          this.observer = Observable.binding(source, this, false);
          this.observer.handleChange = this.observer.call;
          this.handleChange();
        }
        disconnect() {
          this.observer.disconnect();
        }
        /**
         * @internal
         */
        handleChange() {
          try {
            this.node.store.set(this.token, this.observer.observe(this.node.target, defaultExecutionContext));
          } catch (e) {
            console.error(e);
          }
        }
      };
      Store = class {
        constructor() {
          this.values = /* @__PURE__ */ new Map();
        }
        set(token, value) {
          if (this.values.get(token) !== value) {
            this.values.set(token, value);
            Observable.getNotifier(this).notify(token.id);
          }
        }
        get(token) {
          Observable.track(this, token.id);
          return this.values.get(token);
        }
        delete(token) {
          this.values.delete(token);
          Observable.getNotifier(this).notify(token.id);
        }
        all() {
          return this.values.entries();
        }
      };
      nodeCache = /* @__PURE__ */ new WeakMap();
      childToParent = /* @__PURE__ */ new WeakMap();
      DesignTokenNode = class _DesignTokenNode {
        constructor(target) {
          this.target = target;
          this.store = new Store();
          this.children = [];
          this.assignedValues = /* @__PURE__ */ new Map();
          this.reflecting = /* @__PURE__ */ new Set();
          this.bindingObservers = /* @__PURE__ */ new Map();
          this.tokenValueChangeHandler = {
            handleChange: (source, arg) => {
              const token = DesignTokenImpl.getTokenById(arg);
              if (token) {
                token.notify(this.target);
                this.updateCSSTokenReflection(source, token);
              }
            }
          };
          nodeCache.set(target, this);
          Observable.getNotifier(this.store).subscribe(this.tokenValueChangeHandler);
          if (target instanceof FASTElement) {
            target.$fastController.addBehaviors([this]);
          } else if (target.isConnected) {
            this.bind();
          }
        }
        /**
         * Returns a DesignTokenNode for an element.
         * Creates a new instance if one does not already exist for a node,
         * otherwise returns the cached instance
         *
         * @param target - The HTML element to retrieve a DesignTokenNode for
         */
        static getOrCreate(target) {
          return nodeCache.get(target) || new _DesignTokenNode(target);
        }
        /**
         * Determines if a DesignTokenNode has been created for a target
         * @param target - The element to test
         */
        static existsFor(target) {
          return nodeCache.has(target);
        }
        /**
         * Searches for and return the nearest parent DesignTokenNode.
         * Null is returned if no node is found or the node provided is for a default element.
         */
        static findParent(node) {
          if (!(defaultElement === node.target)) {
            let parent = composedParent(node.target);
            while (parent !== null) {
              if (nodeCache.has(parent)) {
                return nodeCache.get(parent);
              }
              parent = composedParent(parent);
            }
            return _DesignTokenNode.getOrCreate(defaultElement);
          }
          return null;
        }
        /**
         * Finds the closest node with a value explicitly assigned for a token, otherwise null.
         * @param token - The token to look for
         * @param start - The node to start looking for value assignment
         * @returns
         */
        static findClosestAssignedNode(token, start) {
          let current = start;
          do {
            if (current.has(token)) {
              return current;
            }
            current = current.parent ? current.parent : current.target !== defaultElement ? _DesignTokenNode.getOrCreate(defaultElement) : null;
          } while (current !== null);
          return null;
        }
        /**
         * The parent DesignTokenNode, or null.
         */
        get parent() {
          return childToParent.get(this) || null;
        }
        updateCSSTokenReflection(source, token) {
          if (DesignTokenImpl.isCSSDesignToken(token)) {
            const parent = this.parent;
            const reflecting = this.isReflecting(token);
            if (parent) {
              const parentValue = parent.get(token);
              const sourceValue = source.get(token);
              if (parentValue !== sourceValue && !reflecting) {
                this.reflectToCSS(token);
              } else if (parentValue === sourceValue && reflecting) {
                this.stopReflectToCSS(token);
              }
            } else if (!reflecting) {
              this.reflectToCSS(token);
            }
          }
        }
        /**
         * Checks if a token has been assigned an explicit value the node.
         * @param token - the token to check.
         */
        has(token) {
          return this.assignedValues.has(token);
        }
        /**
         * Gets the value of a token for a node
         * @param token - The token to retrieve the value for
         * @returns
         */
        get(token) {
          const value = this.store.get(token);
          if (value !== void 0) {
            return value;
          }
          const raw = this.getRaw(token);
          if (raw !== void 0) {
            this.hydrate(token, raw);
            return this.get(token);
          }
        }
        /**
         * Retrieves the raw assigned value of a token from the nearest assigned node.
         * @param token - The token to retrieve a raw value for
         * @returns
         */
        getRaw(token) {
          var _a;
          if (this.assignedValues.has(token)) {
            return this.assignedValues.get(token);
          }
          return (_a = _DesignTokenNode.findClosestAssignedNode(token, this)) === null || _a === void 0 ? void 0 : _a.getRaw(token);
        }
        /**
         * Sets a token to a value for a node
         * @param token - The token to set
         * @param value - The value to set the token to
         */
        set(token, value) {
          if (DesignTokenImpl.isDerivedDesignTokenValue(this.assignedValues.get(token))) {
            this.tearDownBindingObserver(token);
          }
          this.assignedValues.set(token, value);
          if (DesignTokenImpl.isDerivedDesignTokenValue(value)) {
            this.setupBindingObserver(token, value);
          } else {
            this.store.set(token, value);
          }
        }
        /**
         * Deletes a token value for the node.
         * @param token - The token to delete the value for
         */
        delete(token) {
          this.assignedValues.delete(token);
          this.tearDownBindingObserver(token);
          const upstream = this.getRaw(token);
          if (upstream) {
            this.hydrate(token, upstream);
          } else {
            this.store.delete(token);
          }
        }
        /**
         * Invoked when the DesignTokenNode.target is attached to the document
         */
        bind() {
          const parent = _DesignTokenNode.findParent(this);
          if (parent) {
            parent.appendChild(this);
          }
          for (const key of this.assignedValues.keys()) {
            key.notify(this.target);
          }
        }
        /**
         * Invoked when the DesignTokenNode.target is detached from the document
         */
        unbind() {
          if (this.parent) {
            const parent = childToParent.get(this);
            parent.removeChild(this);
          }
          for (const token of this.bindingObservers.keys()) {
            this.tearDownBindingObserver(token);
          }
        }
        /**
         * Appends a child to a parent DesignTokenNode.
         * @param child - The child to append to the node
         */
        appendChild(child) {
          if (child.parent) {
            childToParent.get(child).removeChild(child);
          }
          const reParent = this.children.filter((x) => child.contains(x));
          childToParent.set(child, this);
          this.children.push(child);
          reParent.forEach((x) => child.appendChild(x));
          Observable.getNotifier(this.store).subscribe(child);
          for (const [token, value] of this.store.all()) {
            child.hydrate(token, this.bindingObservers.has(token) ? this.getRaw(token) : value);
            child.updateCSSTokenReflection(child.store, token);
          }
        }
        /**
         * Removes a child from a node.
         * @param child - The child to remove.
         */
        removeChild(child) {
          const childIndex = this.children.indexOf(child);
          if (childIndex !== -1) {
            this.children.splice(childIndex, 1);
          }
          Observable.getNotifier(this.store).unsubscribe(child);
          if (child.parent !== this) {
            return false;
          }
          const deleted = childToParent.delete(child);
          for (const [token] of this.store.all()) {
            child.hydrate(token, child.getRaw(token));
            child.updateCSSTokenReflection(child.store, token);
          }
          return deleted;
        }
        /**
         * Tests whether a provided node is contained by
         * the calling node.
         * @param test - The node to test
         */
        contains(test) {
          return composedContains(this.target, test.target);
        }
        /**
         * Instructs the node to reflect a design token for the provided token.
         * @param token - The design token to reflect
         */
        reflectToCSS(token) {
          if (!this.isReflecting(token)) {
            this.reflecting.add(token);
            _DesignTokenNode.cssCustomPropertyReflector.startReflection(token, this.target);
          }
        }
        /**
         * Stops reflecting a DesignToken to CSS
         * @param token - The design token to stop reflecting
         */
        stopReflectToCSS(token) {
          if (this.isReflecting(token)) {
            this.reflecting.delete(token);
            _DesignTokenNode.cssCustomPropertyReflector.stopReflection(token, this.target);
          }
        }
        /**
         * Determines if a token is being reflected to CSS for a node.
         * @param token - The token to check for reflection
         * @returns
         */
        isReflecting(token) {
          return this.reflecting.has(token);
        }
        /**
         * Handle changes to upstream tokens
         * @param source - The parent DesignTokenNode
         * @param property - The token ID that changed
         */
        handleChange(source, property) {
          const token = DesignTokenImpl.getTokenById(property);
          if (!token) {
            return;
          }
          this.hydrate(token, this.getRaw(token));
          this.updateCSSTokenReflection(this.store, token);
        }
        /**
         * Hydrates a token with a DesignTokenValue, making retrieval available.
         * @param token - The token to hydrate
         * @param value - The value to hydrate
         */
        hydrate(token, value) {
          if (!this.has(token)) {
            const observer = this.bindingObservers.get(token);
            if (DesignTokenImpl.isDerivedDesignTokenValue(value)) {
              if (observer) {
                if (observer.source !== value) {
                  this.tearDownBindingObserver(token);
                  this.setupBindingObserver(token, value);
                }
              } else {
                this.setupBindingObserver(token, value);
              }
            } else {
              if (observer) {
                this.tearDownBindingObserver(token);
              }
              this.store.set(token, value);
            }
          }
        }
        /**
         * Sets up a binding observer for a derived token value that notifies token
         * subscribers on change.
         *
         * @param token - The token to notify when the binding updates
         * @param source - The binding source
         */
        setupBindingObserver(token, source) {
          const binding = new DesignTokenBindingObserver(source, token, this);
          this.bindingObservers.set(token, binding);
          return binding;
        }
        /**
         * Tear down a binding observer for a token.
         */
        tearDownBindingObserver(token) {
          if (this.bindingObservers.has(token)) {
            this.bindingObservers.get(token).disconnect();
            this.bindingObservers.delete(token);
            return true;
          }
          return false;
        }
      };
      DesignTokenNode.cssCustomPropertyReflector = new CustomPropertyReflector();
      __decorate([
        observable
      ], DesignTokenNode.prototype, "children", void 0);
      DesignToken = Object.freeze({
        create,
        /**
         * Informs DesignToken that an HTMLElement for which tokens have
         * been set has been connected to the document.
         *
         * The browser does not provide a reliable mechanism to observe an HTMLElement's connectedness
         * in all scenarios, so invoking this method manually is necessary when:
         *
         * 1. Token values are set for an HTMLElement.
         * 2. The HTMLElement does not inherit from FASTElement.
         * 3. The HTMLElement is not connected to the document when token values are set.
         *
         * @param element - The element to notify
         * @returns - true if notification was successful, otherwise false.
         */
        notifyConnection(element) {
          if (!element.isConnected || !DesignTokenNode.existsFor(element)) {
            return false;
          }
          DesignTokenNode.getOrCreate(element).bind();
          return true;
        },
        /**
         * Informs DesignToken that an HTMLElement for which tokens have
         * been set has been disconnected to the document.
         *
         * The browser does not provide a reliable mechanism to observe an HTMLElement's connectedness
         * in all scenarios, so invoking this method manually is necessary when:
         *
         * 1. Token values are set for an HTMLElement.
         * 2. The HTMLElement does not inherit from FASTElement.
         *
         * @param element - The element to notify
         * @returns - true if notification was successful, otherwise false.
         */
        notifyDisconnection(element) {
          if (element.isConnected || !DesignTokenNode.existsFor(element)) {
            return false;
          }
          DesignTokenNode.getOrCreate(element).unbind();
          return true;
        },
        /**
         * Registers and element or document as a DesignToken root.
         * {@link CSSDesignToken | CSSDesignTokens} with default values assigned via
         * {@link (DesignToken:interface).withDefault} will emit CSS custom properties to all
         * registered roots.
         * @param target - The root to register
         */
        registerRoot(target = defaultElement) {
          RootStyleSheetTarget.registerRoot(target);
        },
        /**
         * Unregister an element or document as a DesignToken root.
         * @param target - The root to deregister
         */
        unregisterRoot(target = defaultElement) {
          RootStyleSheetTarget.unregisterRoot(target);
        }
      });
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/design-system/design-system.js
  function extractTryDefineElementParams(params, elementDefinitionType, elementDefinitionCallback) {
    if (typeof params === "string") {
      return {
        name: params,
        type: elementDefinitionType,
        callback: elementDefinitionCallback
      };
    } else {
      return params;
    }
  }
  var ElementDisambiguation, elementTypesByTag, elementTagsByType, rootDesignSystem, designSystemKey, DesignSystem, DefaultDesignSystem, ElementDefinitionEntry;
  var init_design_system = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/design-system/design-system.js"() {
      init_esm();
      init_foundation_element();
      init_di();
      init_design_token();
      init_component_presentation();
      ElementDisambiguation = Object.freeze({
        /**
         * Skip defining the element but still call the provided callback passed
         * to DesignSystemRegistrationContext.tryDefineElement
         */
        definitionCallbackOnly: null,
        /**
         * Ignore the duplicate element entirely.
         */
        ignoreDuplicate: /* @__PURE__ */ Symbol()
      });
      elementTypesByTag = /* @__PURE__ */ new Map();
      elementTagsByType = /* @__PURE__ */ new Map();
      rootDesignSystem = null;
      designSystemKey = DI.createInterface((x) => x.cachedCallback((handler) => {
        if (rootDesignSystem === null) {
          rootDesignSystem = new DefaultDesignSystem(null, handler);
        }
        return rootDesignSystem;
      }));
      DesignSystem = Object.freeze({
        /**
         * Returns the HTML element name that the type is defined as.
         * @param type - The type to lookup.
         * @public
         */
        tagFor(type) {
          return elementTagsByType.get(type);
        },
        /**
         * Searches the DOM hierarchy for the design system that is responsible
         * for the provided element.
         * @param element - The element to locate the design system for.
         * @returns The located design system.
         * @public
         */
        responsibleFor(element) {
          const owned = element.$$designSystem$$;
          if (owned) {
            return owned;
          }
          const container = DI.findResponsibleContainer(element);
          return container.get(designSystemKey);
        },
        /**
         * Gets the DesignSystem if one is explicitly defined on the provided element;
         * otherwise creates a design system defined directly on the element.
         * @param element - The element to get or create a design system for.
         * @returns The design system.
         * @public
         */
        getOrCreate(node) {
          if (!node) {
            if (rootDesignSystem === null) {
              rootDesignSystem = DI.getOrCreateDOMContainer().get(designSystemKey);
            }
            return rootDesignSystem;
          }
          const owned = node.$$designSystem$$;
          if (owned) {
            return owned;
          }
          const container = DI.getOrCreateDOMContainer(node);
          if (container.has(designSystemKey, false)) {
            return container.get(designSystemKey);
          } else {
            const system = new DefaultDesignSystem(node, container);
            container.register(Registration.instance(designSystemKey, system));
            return system;
          }
        }
      });
      DefaultDesignSystem = class {
        constructor(owner, container) {
          this.owner = owner;
          this.container = container;
          this.designTokensInitialized = false;
          this.prefix = "fast";
          this.shadowRootMode = void 0;
          this.disambiguate = () => ElementDisambiguation.definitionCallbackOnly;
          if (owner !== null) {
            owner.$$designSystem$$ = this;
          }
        }
        withPrefix(prefix) {
          this.prefix = prefix;
          return this;
        }
        withShadowRootMode(mode) {
          this.shadowRootMode = mode;
          return this;
        }
        withElementDisambiguation(callback) {
          this.disambiguate = callback;
          return this;
        }
        withDesignTokenRoot(root) {
          this.designTokenRoot = root;
          return this;
        }
        register(...registrations) {
          const container = this.container;
          const elementDefinitionEntries = [];
          const disambiguate = this.disambiguate;
          const shadowRootMode = this.shadowRootMode;
          const context = {
            elementPrefix: this.prefix,
            tryDefineElement(params, elementDefinitionType, elementDefinitionCallback) {
              const extractedParams = extractTryDefineElementParams(params, elementDefinitionType, elementDefinitionCallback);
              const { name, callback, baseClass } = extractedParams;
              let { type } = extractedParams;
              let elementName = name;
              let typeFoundByName = elementTypesByTag.get(elementName);
              let needsDefine = true;
              while (typeFoundByName) {
                const result = disambiguate(elementName, type, typeFoundByName);
                switch (result) {
                  case ElementDisambiguation.ignoreDuplicate:
                    return;
                  case ElementDisambiguation.definitionCallbackOnly:
                    needsDefine = false;
                    typeFoundByName = void 0;
                    break;
                  default:
                    elementName = result;
                    typeFoundByName = elementTypesByTag.get(elementName);
                    break;
                }
              }
              if (needsDefine) {
                if (elementTagsByType.has(type) || type === FoundationElement) {
                  type = class extends type {
                  };
                }
                elementTypesByTag.set(elementName, type);
                elementTagsByType.set(type, elementName);
                if (baseClass) {
                  elementTagsByType.set(baseClass, elementName);
                }
              }
              elementDefinitionEntries.push(new ElementDefinitionEntry(container, elementName, type, shadowRootMode, callback, needsDefine));
            }
          };
          if (!this.designTokensInitialized) {
            this.designTokensInitialized = true;
            if (this.designTokenRoot !== null) {
              DesignToken.registerRoot(this.designTokenRoot);
            }
          }
          container.registerWithContext(context, ...registrations);
          for (const entry of elementDefinitionEntries) {
            entry.callback(entry);
            if (entry.willDefine && entry.definition !== null) {
              entry.definition.define();
            }
          }
          return this;
        }
      };
      ElementDefinitionEntry = class {
        constructor(container, name, type, shadowRootMode, callback, willDefine) {
          this.container = container;
          this.name = name;
          this.type = type;
          this.shadowRootMode = shadowRootMode;
          this.callback = callback;
          this.willDefine = willDefine;
          this.definition = null;
        }
        definePresentation(presentation) {
          ComponentPresentation.define(this.name, presentation, this.container);
        }
        defineElement(definition) {
          this.definition = new FASTElementDefinition(this.type, Object.assign(Object.assign({}, definition), { name: this.name }));
        }
        tagFor(type) {
          return DesignSystem.tagFor(type);
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/design-system/registration-context.js
  var init_registration_context = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/design-system/registration-context.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/design-system/index.js
  var init_design_system2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/design-system/index.js"() {
      init_design_system();
      init_component_presentation();
      init_registration_context();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/di/index.js
  var init_di2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/di/index.js"() {
      init_di();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/dialog/dialog.template.js
  var init_dialog_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/dialog/dialog.template.js"() {
    }
  });

  // node_modules/tabbable/dist/index.esm.js
  var candidateSelectors, candidateSelector, NoElement, matches, getRootNode, getTabindex, isInput, isHiddenInput, isDetailsWithSummary, getCheckedRadio, isTabbableRadio, isRadio, isNonTabbableRadio, isZeroArea, isHidden, isDisabledFromFieldset, isNodeMatchingSelectorFocusable, isNodeMatchingSelectorTabbable, isTabbable, focusableCandidateSelector, isFocusable;
  var init_index_esm = __esm({
    "node_modules/tabbable/dist/index.esm.js"() {
      candidateSelectors = ["input", "select", "textarea", "a[href]", "button", "[tabindex]:not(slot)", "audio[controls]", "video[controls]", '[contenteditable]:not([contenteditable="false"])', "details>summary:first-of-type", "details"];
      candidateSelector = /* @__PURE__ */ candidateSelectors.join(",");
      NoElement = typeof Element === "undefined";
      matches = NoElement ? function() {
      } : Element.prototype.matches || Element.prototype.msMatchesSelector || Element.prototype.webkitMatchesSelector;
      getRootNode = !NoElement && Element.prototype.getRootNode ? function(element) {
        return element.getRootNode();
      } : function(element) {
        return element.ownerDocument;
      };
      getTabindex = function getTabindex2(node, isScope) {
        if (node.tabIndex < 0) {
          if ((isScope || /^(AUDIO|VIDEO|DETAILS)$/.test(node.tagName) || node.isContentEditable) && isNaN(parseInt(node.getAttribute("tabindex"), 10))) {
            return 0;
          }
        }
        return node.tabIndex;
      };
      isInput = function isInput2(node) {
        return node.tagName === "INPUT";
      };
      isHiddenInput = function isHiddenInput2(node) {
        return isInput(node) && node.type === "hidden";
      };
      isDetailsWithSummary = function isDetailsWithSummary2(node) {
        var r = node.tagName === "DETAILS" && Array.prototype.slice.apply(node.children).some(function(child) {
          return child.tagName === "SUMMARY";
        });
        return r;
      };
      getCheckedRadio = function getCheckedRadio2(nodes, form) {
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].checked && nodes[i].form === form) {
            return nodes[i];
          }
        }
      };
      isTabbableRadio = function isTabbableRadio2(node) {
        if (!node.name) {
          return true;
        }
        var radioScope = node.form || getRootNode(node);
        var queryRadios = function queryRadios2(name) {
          return radioScope.querySelectorAll('input[type="radio"][name="' + name + '"]');
        };
        var radioSet;
        if (typeof window !== "undefined" && typeof window.CSS !== "undefined" && typeof window.CSS.escape === "function") {
          radioSet = queryRadios(window.CSS.escape(node.name));
        } else {
          try {
            radioSet = queryRadios(node.name);
          } catch (err) {
            console.error("Looks like you have a radio button with a name attribute containing invalid CSS selector characters and need the CSS.escape polyfill: %s", err.message);
            return false;
          }
        }
        var checked = getCheckedRadio(radioSet, node.form);
        return !checked || checked === node;
      };
      isRadio = function isRadio2(node) {
        return isInput(node) && node.type === "radio";
      };
      isNonTabbableRadio = function isNonTabbableRadio2(node) {
        return isRadio(node) && !isTabbableRadio(node);
      };
      isZeroArea = function isZeroArea2(node) {
        var _node$getBoundingClie = node.getBoundingClientRect(), width = _node$getBoundingClie.width, height = _node$getBoundingClie.height;
        return width === 0 && height === 0;
      };
      isHidden = function isHidden2(node, _ref) {
        var displayCheck = _ref.displayCheck, getShadowRoot2 = _ref.getShadowRoot;
        if (getComputedStyle(node).visibility === "hidden") {
          return true;
        }
        var isDirectSummary = matches.call(node, "details>summary:first-of-type");
        var nodeUnderDetails = isDirectSummary ? node.parentElement : node;
        if (matches.call(nodeUnderDetails, "details:not([open]) *")) {
          return true;
        }
        var nodeRootHost = getRootNode(node).host;
        var nodeIsAttached = (nodeRootHost === null || nodeRootHost === void 0 ? void 0 : nodeRootHost.ownerDocument.contains(nodeRootHost)) || node.ownerDocument.contains(node);
        if (!displayCheck || displayCheck === "full") {
          if (typeof getShadowRoot2 === "function") {
            var originalNode = node;
            while (node) {
              var parentElement = node.parentElement;
              var rootNode = getRootNode(node);
              if (parentElement && !parentElement.shadowRoot && getShadowRoot2(parentElement) === true) {
                return isZeroArea(node);
              } else if (node.assignedSlot) {
                node = node.assignedSlot;
              } else if (!parentElement && rootNode !== node.ownerDocument) {
                node = rootNode.host;
              } else {
                node = parentElement;
              }
            }
            node = originalNode;
          }
          if (nodeIsAttached) {
            return !node.getClientRects().length;
          }
        } else if (displayCheck === "non-zero-area") {
          return isZeroArea(node);
        }
        return false;
      };
      isDisabledFromFieldset = function isDisabledFromFieldset2(node) {
        if (/^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(node.tagName)) {
          var parentNode = node.parentElement;
          while (parentNode) {
            if (parentNode.tagName === "FIELDSET" && parentNode.disabled) {
              for (var i = 0; i < parentNode.children.length; i++) {
                var child = parentNode.children.item(i);
                if (child.tagName === "LEGEND") {
                  return matches.call(parentNode, "fieldset[disabled] *") ? true : !child.contains(node);
                }
              }
              return true;
            }
            parentNode = parentNode.parentElement;
          }
        }
        return false;
      };
      isNodeMatchingSelectorFocusable = function isNodeMatchingSelectorFocusable2(options, node) {
        if (node.disabled || isHiddenInput(node) || isHidden(node, options) || // For a details element with a summary, the summary element gets the focus
        isDetailsWithSummary(node) || isDisabledFromFieldset(node)) {
          return false;
        }
        return true;
      };
      isNodeMatchingSelectorTabbable = function isNodeMatchingSelectorTabbable2(options, node) {
        if (isNonTabbableRadio(node) || getTabindex(node) < 0 || !isNodeMatchingSelectorFocusable(options, node)) {
          return false;
        }
        return true;
      };
      isTabbable = function isTabbable2(node, options) {
        options = options || {};
        if (!node) {
          throw new Error("No node provided");
        }
        if (matches.call(node, candidateSelector) === false) {
          return false;
        }
        return isNodeMatchingSelectorTabbable(options, node);
      };
      focusableCandidateSelector = /* @__PURE__ */ candidateSelectors.concat("iframe").join(",");
      isFocusable = function isFocusable2(node, options) {
        options = options || {};
        if (!node) {
          throw new Error("No node provided");
        }
        if (matches.call(node, focusableCandidateSelector) === false) {
          return false;
        }
        return isNodeMatchingSelectorFocusable(options, node);
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/dialog/dialog.js
  var Dialog;
  var init_dialog = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/dialog/dialog.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_index_esm();
      init_foundation_element();
      Dialog = class _Dialog extends FoundationElement {
        constructor() {
          super(...arguments);
          this.modal = true;
          this.hidden = false;
          this.trapFocus = true;
          this.trapFocusChanged = () => {
            if (this.$fastController.isConnected) {
              this.updateTrapFocus();
            }
          };
          this.isTrappingFocus = false;
          this.handleDocumentKeydown = (e) => {
            if (!e.defaultPrevented && !this.hidden) {
              switch (e.key) {
                case keyEscape:
                  this.dismiss();
                  e.preventDefault();
                  break;
                case keyTab:
                  this.handleTabKeyDown(e);
                  break;
              }
            }
          };
          this.handleDocumentFocus = (e) => {
            if (!e.defaultPrevented && this.shouldForceFocus(e.target)) {
              this.focusFirstElement();
              e.preventDefault();
            }
          };
          this.handleTabKeyDown = (e) => {
            if (!this.trapFocus || this.hidden) {
              return;
            }
            const bounds = this.getTabQueueBounds();
            if (bounds.length === 0) {
              return;
            }
            if (bounds.length === 1) {
              bounds[0].focus();
              e.preventDefault();
              return;
            }
            if (e.shiftKey && e.target === bounds[0]) {
              bounds[bounds.length - 1].focus();
              e.preventDefault();
            } else if (!e.shiftKey && e.target === bounds[bounds.length - 1]) {
              bounds[0].focus();
              e.preventDefault();
            }
            return;
          };
          this.getTabQueueBounds = () => {
            const bounds = [];
            return _Dialog.reduceTabbableItems(bounds, this);
          };
          this.focusFirstElement = () => {
            const bounds = this.getTabQueueBounds();
            if (bounds.length > 0) {
              bounds[0].focus();
            } else {
              if (this.dialog instanceof HTMLElement) {
                this.dialog.focus();
              }
            }
          };
          this.shouldForceFocus = (currentFocusElement) => {
            return this.isTrappingFocus && !this.contains(currentFocusElement);
          };
          this.shouldTrapFocus = () => {
            return this.trapFocus && !this.hidden;
          };
          this.updateTrapFocus = (shouldTrapFocusOverride) => {
            const shouldTrapFocus = shouldTrapFocusOverride === void 0 ? this.shouldTrapFocus() : shouldTrapFocusOverride;
            if (shouldTrapFocus && !this.isTrappingFocus) {
              this.isTrappingFocus = true;
              document.addEventListener("focusin", this.handleDocumentFocus);
              DOM.queueUpdate(() => {
                if (this.shouldForceFocus(document.activeElement)) {
                  this.focusFirstElement();
                }
              });
            } else if (!shouldTrapFocus && this.isTrappingFocus) {
              this.isTrappingFocus = false;
              document.removeEventListener("focusin", this.handleDocumentFocus);
            }
          };
        }
        /**
         * @internal
         */
        dismiss() {
          this.$emit("dismiss");
          this.$emit("cancel");
        }
        /**
         * The method to show the dialog.
         *
         * @public
         */
        show() {
          this.hidden = false;
        }
        /**
         * The method to hide the dialog.
         *
         * @public
         */
        hide() {
          this.hidden = true;
          this.$emit("close");
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          document.addEventListener("keydown", this.handleDocumentKeydown);
          this.notifier = Observable.getNotifier(this);
          this.notifier.subscribe(this, "hidden");
          this.updateTrapFocus();
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          super.disconnectedCallback();
          document.removeEventListener("keydown", this.handleDocumentKeydown);
          this.updateTrapFocus(false);
          this.notifier.unsubscribe(this, "hidden");
        }
        /**
         * @internal
         */
        handleChange(source, propertyName) {
          switch (propertyName) {
            case "hidden":
              this.updateTrapFocus();
              break;
            default:
              break;
          }
        }
        /**
         * Reduce a collection to only its focusable elements.
         *
         * @param elements - Collection of elements to reduce
         * @param element - The current element
         *
         * @internal
         */
        static reduceTabbableItems(elements2, element) {
          if (element.getAttribute("tabindex") === "-1") {
            return elements2;
          }
          if (isTabbable(element) || _Dialog.isFocusableFastElement(element) && _Dialog.hasTabbableShadow(element)) {
            elements2.push(element);
            return elements2;
          }
          if (element.childElementCount) {
            return elements2.concat(Array.from(element.children).reduce(_Dialog.reduceTabbableItems, []));
          }
          return elements2;
        }
        /**
         * Test if element is focusable fast element
         *
         * @param element - The element to check
         *
         * @internal
         */
        static isFocusableFastElement(element) {
          var _a, _b;
          return !!((_b = (_a = element.$fastController) === null || _a === void 0 ? void 0 : _a.definition.shadowOptions) === null || _b === void 0 ? void 0 : _b.delegatesFocus);
        }
        /**
         * Test if the element has a focusable shadow
         *
         * @param element - The element to check
         *
         * @internal
         */
        static hasTabbableShadow(element) {
          var _a, _b;
          return Array.from((_b = (_a = element.shadowRoot) === null || _a === void 0 ? void 0 : _a.querySelectorAll("*")) !== null && _b !== void 0 ? _b : []).some((x) => {
            return isTabbable(x);
          });
        }
      };
      __decorate([
        attr({ mode: "boolean" })
      ], Dialog.prototype, "modal", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], Dialog.prototype, "hidden", void 0);
      __decorate([
        attr({ attribute: "trap-focus", mode: "boolean" })
      ], Dialog.prototype, "trapFocus", void 0);
      __decorate([
        attr({ attribute: "aria-describedby" })
      ], Dialog.prototype, "ariaDescribedby", void 0);
      __decorate([
        attr({ attribute: "aria-labelledby" })
      ], Dialog.prototype, "ariaLabelledby", void 0);
      __decorate([
        attr({ attribute: "aria-label" })
      ], Dialog.prototype, "ariaLabel", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/dialog/index.js
  var init_dialog2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/dialog/index.js"() {
      init_dialog_template();
      init_dialog();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/disclosure/disclosure.template.js
  var init_disclosure_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/disclosure/disclosure.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/disclosure/disclosure.js
  var Disclosure;
  var init_disclosure = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/disclosure/disclosure.js"() {
      init_tslib_es6();
      init_esm();
      init_foundation_element();
      Disclosure = class extends FoundationElement {
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.setup();
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          super.disconnectedCallback();
          this.details.removeEventListener("toggle", this.onToggle);
        }
        /**
         * Show extra content.
         */
        show() {
          this.details.open = true;
        }
        /**
         * Hide extra content.
         */
        hide() {
          this.details.open = false;
        }
        /**
         * Toggle the current(expanded/collapsed) state.
         */
        toggle() {
          this.details.open = !this.details.open;
        }
        /**
         * Register listener and set default disclosure mode
         */
        setup() {
          this.onToggle = this.onToggle.bind(this);
          this.details.addEventListener("toggle", this.onToggle);
          if (this.expanded) {
            this.show();
          }
        }
        /**
         * Update the aria attr and fire `toggle` event
         */
        onToggle() {
          this.expanded = this.details.open;
          this.$emit("toggle");
        }
      };
      __decorate([
        attr({ mode: "boolean" })
      ], Disclosure.prototype, "expanded", void 0);
      __decorate([
        attr
      ], Disclosure.prototype, "title", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/disclosure/index.js
  var init_disclosure2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/disclosure/index.js"() {
      init_disclosure_template();
      init_disclosure();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/divider/divider.template.js
  var dividerTemplate;
  var init_divider_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/divider/divider.template.js"() {
      init_esm();
      dividerTemplate = (context, definition) => html`
    <template role="${(x) => x.role}" aria-orientation="${(x) => x.orientation}"></template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/divider/divider.options.js
  var DividerRole;
  var init_divider_options = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/divider/divider.options.js"() {
      DividerRole = {
        /**
         * The divider semantically separates content
         */
        separator: "separator",
        /**
         * The divider has no semantic value and is for visual presentation only.
         */
        presentation: "presentation"
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/divider/divider.js
  var Divider;
  var init_divider = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/divider/divider.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_foundation_element();
      init_divider_options();
      Divider = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.role = DividerRole.separator;
          this.orientation = Orientation.horizontal;
        }
      };
      __decorate([
        attr
      ], Divider.prototype, "role", void 0);
      __decorate([
        attr
      ], Divider.prototype, "orientation", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/divider/index.js
  var init_divider2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/divider/index.js"() {
      init_divider_template();
      init_divider();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/flipper/flipper.options.js
  var FlipperDirection;
  var init_flipper_options = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/flipper/flipper.options.js"() {
      FlipperDirection = {
        next: "next",
        previous: "previous"
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/flipper/flipper.template.js
  var init_flipper_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/flipper/flipper.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/flipper/flipper.js
  var Flipper;
  var init_flipper = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/flipper/flipper.js"() {
      init_tslib_es6();
      init_esm();
      init_foundation_element();
      init_flipper_options();
      Flipper = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.hiddenFromAT = true;
          this.direction = FlipperDirection.next;
        }
        /**
         * Simulate a click event when the flipper has focus and the user hits enter or space keys
         * Blur focus if the user hits escape key
         * @param e - Keyboard event
         * @public
         */
        keyupHandler(e) {
          if (!this.hiddenFromAT) {
            const key = e.key;
            if (key === "Enter" || key === "Space") {
              this.$emit("click", e);
            }
            if (key === "Escape") {
              this.blur();
            }
          }
        }
      };
      __decorate([
        attr({ mode: "boolean" })
      ], Flipper.prototype, "disabled", void 0);
      __decorate([
        attr({ attribute: "aria-hidden", converter: booleanConverter })
      ], Flipper.prototype, "hiddenFromAT", void 0);
      __decorate([
        attr
      ], Flipper.prototype, "direction", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/flipper/index.js
  var init_flipper2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/flipper/index.js"() {
      init_flipper_template();
      init_flipper();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/form-associated/index.js
  var init_form_associated2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/form-associated/index.js"() {
      init_form_associated();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/foundation-element/index.js
  var init_foundation_element2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/foundation-element/index.js"() {
      init_foundation_element();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/listbox-option/listbox-option.template.js
  var listboxOptionTemplate;
  var init_listbox_option_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/listbox-option/listbox-option.template.js"() {
      init_esm();
      init_start_end();
      listboxOptionTemplate = (context, definition) => html`
    <template
        aria-checked="${(x) => x.ariaChecked}"
        aria-disabled="${(x) => x.ariaDisabled}"
        aria-posinset="${(x) => x.ariaPosInSet}"
        aria-selected="${(x) => x.ariaSelected}"
        aria-setsize="${(x) => x.ariaSetSize}"
        class="${(x) => [x.checked && "checked", x.selected && "selected", x.disabled && "disabled"].filter(Boolean).join(" ")}"
        role="option"
    >
        ${startSlotTemplate(context, definition)}
        <span class="content" part="content">
            <slot ${slotted("content")}></slot>
        </span>
        ${endSlotTemplate(context, definition)}
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/listbox-option/index.js
  var init_listbox_option2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/listbox-option/index.js"() {
      init_listbox_option();
      init_listbox_option_template();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/listbox/listbox.element.js
  var ListboxElement;
  var init_listbox_element = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/listbox/listbox.element.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_listbox();
      ListboxElement = class extends Listbox {
        constructor() {
          super(...arguments);
          this.activeIndex = -1;
          this.rangeStartIndex = -1;
        }
        /**
         * Returns the last checked option.
         *
         * @internal
         */
        get activeOption() {
          return this.options[this.activeIndex];
        }
        /**
         * Returns the list of checked options.
         *
         * @internal
         */
        get checkedOptions() {
          var _a;
          return (_a = this.options) === null || _a === void 0 ? void 0 : _a.filter((o) => o.checked);
        }
        /**
         * Returns the index of the first selected option.
         *
         * @internal
         */
        get firstSelectedOptionIndex() {
          return this.options.indexOf(this.firstSelectedOption);
        }
        /**
         * Updates the `ariaActiveDescendant` property when the active index changes.
         *
         * @param prev - the previous active index
         * @param next - the next active index
         *
         * @internal
         */
        activeIndexChanged(prev, next) {
          var _a, _b;
          this.ariaActiveDescendant = (_b = (_a = this.options[next]) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : "";
          this.focusAndScrollOptionIntoView();
        }
        /**
         * Toggles the checked state for the currently active option.
         *
         * @remarks
         * Multiple-selection mode only.
         *
         * @internal
         */
        checkActiveIndex() {
          if (!this.multiple) {
            return;
          }
          const activeItem = this.activeOption;
          if (activeItem) {
            activeItem.checked = true;
          }
        }
        /**
         * Sets the active index to the first option and marks it as checked.
         *
         * @remarks
         * Multi-selection mode only.
         *
         * @param preserveChecked - mark all options unchecked before changing the active index
         *
         * @internal
         */
        checkFirstOption(preserveChecked = false) {
          if (preserveChecked) {
            if (this.rangeStartIndex === -1) {
              this.rangeStartIndex = this.activeIndex + 1;
            }
            this.options.forEach((o, i) => {
              o.checked = inRange(i, this.rangeStartIndex);
            });
          } else {
            this.uncheckAllOptions();
          }
          this.activeIndex = 0;
          this.checkActiveIndex();
        }
        /**
         * Decrements the active index and sets the matching option as checked.
         *
         * @remarks
         * Multi-selection mode only.
         *
         * @param preserveChecked - mark all options unchecked before changing the active index
         *
         * @internal
         */
        checkLastOption(preserveChecked = false) {
          if (preserveChecked) {
            if (this.rangeStartIndex === -1) {
              this.rangeStartIndex = this.activeIndex;
            }
            this.options.forEach((o, i) => {
              o.checked = inRange(i, this.rangeStartIndex, this.options.length);
            });
          } else {
            this.uncheckAllOptions();
          }
          this.activeIndex = this.options.length - 1;
          this.checkActiveIndex();
        }
        /**
         * @override
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.addEventListener("focusout", this.focusoutHandler);
        }
        /**
         * @override
         * @internal
         */
        disconnectedCallback() {
          this.removeEventListener("focusout", this.focusoutHandler);
          super.disconnectedCallback();
        }
        /**
         * Increments the active index and marks the matching option as checked.
         *
         * @remarks
         * Multiple-selection mode only.
         *
         * @param preserveChecked - mark all options unchecked before changing the active index
         *
         * @internal
         */
        checkNextOption(preserveChecked = false) {
          if (preserveChecked) {
            if (this.rangeStartIndex === -1) {
              this.rangeStartIndex = this.activeIndex;
            }
            this.options.forEach((o, i) => {
              o.checked = inRange(i, this.rangeStartIndex, this.activeIndex + 1);
            });
          } else {
            this.uncheckAllOptions();
          }
          this.activeIndex += this.activeIndex < this.options.length - 1 ? 1 : 0;
          this.checkActiveIndex();
        }
        /**
         * Decrements the active index and marks the matching option as checked.
         *
         * @remarks
         * Multiple-selection mode only.
         *
         * @param preserveChecked - mark all options unchecked before changing the active index
         *
         * @internal
         */
        checkPreviousOption(preserveChecked = false) {
          if (preserveChecked) {
            if (this.rangeStartIndex === -1) {
              this.rangeStartIndex = this.activeIndex;
            }
            if (this.checkedOptions.length === 1) {
              this.rangeStartIndex += 1;
            }
            this.options.forEach((o, i) => {
              o.checked = inRange(i, this.activeIndex, this.rangeStartIndex);
            });
          } else {
            this.uncheckAllOptions();
          }
          this.activeIndex -= this.activeIndex > 0 ? 1 : 0;
          this.checkActiveIndex();
        }
        /**
         * Handles click events for listbox options.
         *
         * @param e - the event object
         *
         * @override
         * @internal
         */
        clickHandler(e) {
          var _a;
          if (!this.multiple) {
            return super.clickHandler(e);
          }
          const captured = (_a = e.target) === null || _a === void 0 ? void 0 : _a.closest(`[role=option]`);
          if (!captured || captured.disabled) {
            return;
          }
          this.uncheckAllOptions();
          this.activeIndex = this.options.indexOf(captured);
          this.checkActiveIndex();
          this.toggleSelectedForAllCheckedOptions();
          return true;
        }
        /**
         * @override
         * @internal
         */
        focusAndScrollOptionIntoView() {
          super.focusAndScrollOptionIntoView(this.activeOption);
        }
        /**
         * In multiple-selection mode:
         * If any options are selected, the first selected option is checked when
         * the listbox receives focus. If no options are selected, the first
         * selectable option is checked.
         *
         * @override
         * @internal
         */
        focusinHandler(e) {
          if (!this.multiple) {
            return super.focusinHandler(e);
          }
          if (!this.shouldSkipFocus && e.target === e.currentTarget) {
            this.uncheckAllOptions();
            if (this.activeIndex === -1) {
              this.activeIndex = this.firstSelectedOptionIndex !== -1 ? this.firstSelectedOptionIndex : 0;
            }
            this.checkActiveIndex();
            this.setSelectedOptions();
            this.focusAndScrollOptionIntoView();
          }
          this.shouldSkipFocus = false;
        }
        /**
         * Unchecks all options when the listbox loses focus.
         *
         * @internal
         */
        focusoutHandler(e) {
          if (this.multiple) {
            this.uncheckAllOptions();
          }
        }
        /**
         * Handles keydown actions for listbox navigation and typeahead
         *
         * @override
         * @internal
         */
        keydownHandler(e) {
          if (!this.multiple) {
            return super.keydownHandler(e);
          }
          if (this.disabled) {
            return true;
          }
          const { key, shiftKey } = e;
          this.shouldSkipFocus = false;
          switch (key) {
            // Select the first available option
            case keyHome: {
              this.checkFirstOption(shiftKey);
              return;
            }
            // Select the next selectable option
            case keyArrowDown: {
              this.checkNextOption(shiftKey);
              return;
            }
            // Select the previous selectable option
            case keyArrowUp: {
              this.checkPreviousOption(shiftKey);
              return;
            }
            // Select the last available option
            case keyEnd: {
              this.checkLastOption(shiftKey);
              return;
            }
            case keyTab: {
              this.focusAndScrollOptionIntoView();
              return true;
            }
            case keyEscape: {
              this.uncheckAllOptions();
              this.checkActiveIndex();
              return true;
            }
            case keySpace: {
              e.preventDefault();
              if (this.typeAheadExpired) {
                this.toggleSelectedForAllCheckedOptions();
                return;
              }
            }
            // Send key to Typeahead handler
            default: {
              if (key.length === 1) {
                this.handleTypeAhead(`${key}`);
              }
              return true;
            }
          }
        }
        /**
         * Prevents `focusin` events from firing before `click` events when the
         * element is unfocused.
         *
         * @override
         * @internal
         */
        mousedownHandler(e) {
          if (e.offsetX >= 0 && e.offsetX <= this.scrollWidth) {
            return super.mousedownHandler(e);
          }
        }
        /**
         * Switches between single-selection and multi-selection mode.
         *
         * @internal
         */
        multipleChanged(prev, next) {
          var _a;
          this.ariaMultiSelectable = next ? "true" : null;
          (_a = this.options) === null || _a === void 0 ? void 0 : _a.forEach((o) => {
            o.checked = next ? false : void 0;
          });
          this.setSelectedOptions();
        }
        /**
         * Sets an option as selected and gives it focus.
         *
         * @override
         * @public
         */
        setSelectedOptions() {
          if (!this.multiple) {
            super.setSelectedOptions();
            return;
          }
          if (this.$fastController.isConnected && this.options) {
            this.selectedOptions = this.options.filter((o) => o.selected);
            this.focusAndScrollOptionIntoView();
          }
        }
        /**
         * Ensures the size is a positive integer when the property is updated.
         *
         * @param prev - the previous size value
         * @param next - the current size value
         *
         * @internal
         */
        sizeChanged(prev, next) {
          var _a;
          const size = Math.max(0, parseInt((_a = next === null || next === void 0 ? void 0 : next.toFixed()) !== null && _a !== void 0 ? _a : "", 10));
          if (size !== next) {
            DOM.queueUpdate(() => {
              this.size = size;
            });
          }
        }
        /**
         * Toggles the selected state of the provided options. If any provided items
         * are in an unselected state, all items are set to selected. If every
         * provided item is selected, they are all unselected.
         *
         * @internal
         */
        toggleSelectedForAllCheckedOptions() {
          const enabledCheckedOptions = this.checkedOptions.filter((o) => !o.disabled);
          const force = !enabledCheckedOptions.every((o) => o.selected);
          enabledCheckedOptions.forEach((o) => o.selected = force);
          this.selectedIndex = this.options.indexOf(enabledCheckedOptions[enabledCheckedOptions.length - 1]);
          this.setSelectedOptions();
        }
        /**
         * @override
         * @internal
         */
        typeaheadBufferChanged(prev, next) {
          if (!this.multiple) {
            super.typeaheadBufferChanged(prev, next);
            return;
          }
          if (this.$fastController.isConnected) {
            const typeaheadMatches = this.getTypeaheadMatches();
            const activeIndex = this.options.indexOf(typeaheadMatches[0]);
            if (activeIndex > -1) {
              this.activeIndex = activeIndex;
              this.uncheckAllOptions();
              this.checkActiveIndex();
            }
            this.typeAheadExpired = false;
          }
        }
        /**
         * Unchecks all options.
         *
         * @remarks
         * Multiple-selection mode only.
         *
         * @param preserveChecked - reset the rangeStartIndex
         *
         * @internal
         */
        uncheckAllOptions(preserveChecked = false) {
          this.options.forEach((o) => o.checked = this.multiple ? false : void 0);
          if (!preserveChecked) {
            this.rangeStartIndex = -1;
          }
        }
      };
      __decorate([
        observable
      ], ListboxElement.prototype, "activeIndex", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], ListboxElement.prototype, "multiple", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], ListboxElement.prototype, "size", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/listbox/listbox.template.js
  var init_listbox_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/listbox/listbox.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/listbox/index.js
  var init_listbox2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/listbox/index.js"() {
      init_listbox();
      init_listbox_element();
      init_listbox_template();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-menu.js
  var PickerMenu;
  var init_picker_menu = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-menu.js"() {
      init_tslib_es6();
      init_dist2();
      init_esm();
      init_foundation_element();
      PickerMenu = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.optionElements = [];
        }
        menuElementsChanged() {
          this.updateOptions();
        }
        headerElementsChanged() {
          this.updateOptions();
        }
        footerElementsChanged() {
          this.updateOptions();
        }
        updateOptions() {
          this.optionElements.splice(0, this.optionElements.length);
          this.addSlottedListItems(this.headerElements);
          this.addSlottedListItems(this.menuElements);
          this.addSlottedListItems(this.footerElements);
          this.$emit("optionsupdated", { bubbles: false });
        }
        addSlottedListItems(slotChildren) {
          if (slotChildren === void 0) {
            return;
          }
          slotChildren.forEach((child) => {
            if (child.nodeType === 1 && child.getAttribute("role") === "listitem") {
              child.id = child.id || uniqueId("option-");
              this.optionElements.push(child);
            }
          });
        }
      };
      __decorate([
        observable
      ], PickerMenu.prototype, "menuElements", void 0);
      __decorate([
        observable
      ], PickerMenu.prototype, "headerElements", void 0);
      __decorate([
        observable
      ], PickerMenu.prototype, "footerElements", void 0);
      __decorate([
        observable
      ], PickerMenu.prototype, "suggestionsAvailableText", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-menu-option.js
  var defaultContentsTemplate, PickerMenuOption;
  var init_picker_menu_option = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-menu-option.js"() {
      init_tslib_es6();
      init_esm();
      init_foundation_element();
      defaultContentsTemplate = html`
    <template>
        ${(x) => x.value}
    </template>
`;
      PickerMenuOption = class extends FoundationElement {
        contentsTemplateChanged() {
          if (this.$fastController.isConnected) {
            this.updateView();
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.updateView();
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          super.disconnectedCallback();
          this.disconnectView();
        }
        handleClick(e) {
          if (e.defaultPrevented) {
            return false;
          }
          this.handleInvoked();
          return false;
        }
        handleInvoked() {
          this.$emit("pickeroptioninvoked");
        }
        updateView() {
          var _a, _b;
          this.disconnectView();
          this.customView = (_b = (_a = this.contentsTemplate) === null || _a === void 0 ? void 0 : _a.render(this, this)) !== null && _b !== void 0 ? _b : defaultContentsTemplate.render(this, this);
        }
        disconnectView() {
          var _a;
          (_a = this.customView) === null || _a === void 0 ? void 0 : _a.dispose();
          this.customView = void 0;
        }
      };
      __decorate([
        attr({ attribute: "value" })
      ], PickerMenuOption.prototype, "value", void 0);
      __decorate([
        observable
      ], PickerMenuOption.prototype, "contentsTemplate", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-list.js
  var init_picker_list = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-list.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-list-item.js
  var defaultContentsTemplate2, PickerListItem;
  var init_picker_list_item = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-list-item.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_foundation_element();
      defaultContentsTemplate2 = html`
    <template>
        ${(x) => x.value}
    </template>
`;
      PickerListItem = class extends FoundationElement {
        contentsTemplateChanged() {
          if (this.$fastController.isConnected) {
            this.updateView();
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.updateView();
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          this.disconnectView();
          super.disconnectedCallback();
        }
        handleKeyDown(e) {
          if (e.defaultPrevented) {
            return false;
          }
          if (e.key === keyEnter) {
            this.handleInvoke();
            return false;
          }
          return true;
        }
        handleClick(e) {
          if (!e.defaultPrevented) {
            this.handleInvoke();
          }
          return false;
        }
        handleInvoke() {
          this.$emit("pickeriteminvoked");
        }
        updateView() {
          var _a, _b;
          this.disconnectView();
          this.customView = (_b = (_a = this.contentsTemplate) === null || _a === void 0 ? void 0 : _a.render(this, this)) !== null && _b !== void 0 ? _b : defaultContentsTemplate2.render(this, this);
        }
        disconnectView() {
          var _a;
          (_a = this.customView) === null || _a === void 0 ? void 0 : _a.dispose();
          this.customView = void 0;
        }
      };
      __decorate([
        attr({ attribute: "value" })
      ], PickerListItem.prototype, "value", void 0);
      __decorate([
        observable
      ], PickerListItem.prototype, "contentsTemplate", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/picker.template.js
  var init_picker_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/picker.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/picker.form-associated.js
  var _Picker, FormAssociatedPicker;
  var init_picker_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/picker.form-associated.js"() {
      init_form_associated();
      init_foundation_element();
      _Picker = class extends FoundationElement {
      };
      FormAssociatedPicker = class extends FormAssociated(_Picker) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("input");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/picker.js
  var pickerInputTemplate, Picker;
  var init_picker = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/picker.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_anchored_region2();
      init_picker_menu_option();
      init_picker_list_item();
      init_picker_form_associated();
      pickerInputTemplate = html`
    <input
        slot="input-region"
        role="combobox"
        type="text"
        autocapitalize="off"
        autocomplete="off"
        haspopup="list"
        aria-label="${(x) => x.label}"
        aria-labelledby="${(x) => x.labelledBy}"
        placeholder="${(x) => x.placeholder}"
        ${ref("inputElement")}
    ></input>
`;
      Picker = class extends FormAssociatedPicker {
        constructor() {
          super(...arguments);
          this.selection = "";
          this.filterSelected = true;
          this.filterQuery = true;
          this.noSuggestionsText = "No suggestions available";
          this.suggestionsAvailableText = "Suggestions available";
          this.loadingText = "Loading suggestions";
          this.menuPlacement = "bottom-fill";
          this.showLoading = false;
          this.optionsList = [];
          this.filteredOptionsList = [];
          this.flyoutOpen = false;
          this.menuFocusIndex = -1;
          this.showNoOptions = false;
          this.selectedItems = [];
          this.inputElementView = null;
          this.handleTextInput = (e) => {
            this.query = this.inputElement.value;
          };
          this.handleInputClick = (e) => {
            e.preventDefault();
            this.toggleFlyout(true);
          };
          this.setRegionProps = () => {
            if (!this.flyoutOpen) {
              return;
            }
            if (this.region === null || this.region === void 0) {
              DOM.queueUpdate(this.setRegionProps);
              return;
            }
            this.region.anchorElement = this.inputElement;
          };
          this.configLookup = {
            top: FlyoutPosTop,
            bottom: FlyoutPosBottom,
            tallest: FlyoutPosTallest,
            "top-fill": FlyoutPosTopFill,
            "bottom-fill": FlyoutPosBottomFill,
            "tallest-fill": FlyoutPosTallestFill
          };
        }
        selectionChanged() {
          if (this.$fastController.isConnected) {
            this.handleSelectionChange();
            if (this.proxy instanceof HTMLInputElement) {
              this.proxy.value = this.selection;
              this.validate();
            }
          }
        }
        optionsChanged() {
          this.optionsList = this.options.split(",").map((opt) => opt.trim()).filter((opt) => opt !== "");
        }
        menuPlacementChanged() {
          if (this.$fastController.isConnected) {
            this.updateMenuConfig();
          }
        }
        showLoadingChanged() {
          if (this.$fastController.isConnected) {
            DOM.queueUpdate(() => {
              this.setFocusedOption(0);
            });
          }
        }
        listItemTemplateChanged() {
          this.updateListItemTemplate();
        }
        defaultListItemTemplateChanged() {
          this.updateListItemTemplate();
        }
        menuOptionTemplateChanged() {
          this.updateOptionTemplate();
        }
        defaultMenuOptionTemplateChanged() {
          this.updateOptionTemplate();
        }
        optionsListChanged() {
          this.updateFilteredOptions();
        }
        queryChanged() {
          if (this.$fastController.isConnected) {
            if (this.inputElement.value !== this.query) {
              this.inputElement.value = this.query;
            }
            this.updateFilteredOptions();
            this.$emit("querychange", { bubbles: false });
          }
        }
        filteredOptionsListChanged() {
          if (this.$fastController.isConnected) {
            this.showNoOptions = this.filteredOptionsList.length === 0 && this.menuElement.querySelectorAll('[role="listitem"]').length === 0;
            this.setFocusedOption(this.showNoOptions ? -1 : 0);
          }
        }
        flyoutOpenChanged() {
          if (this.flyoutOpen) {
            DOM.queueUpdate(this.setRegionProps);
            this.$emit("menuopening", { bubbles: false });
          } else {
            this.$emit("menuclosing", { bubbles: false });
          }
        }
        showNoOptionsChanged() {
          if (this.$fastController.isConnected) {
            DOM.queueUpdate(() => {
              this.setFocusedOption(0);
            });
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.listElement = document.createElement(this.selectedListTag);
          this.appendChild(this.listElement);
          this.itemsPlaceholderElement = document.createComment("");
          this.listElement.append(this.itemsPlaceholderElement);
          this.inputElementView = pickerInputTemplate.render(this, this.listElement);
          const match = this.menuTag.toUpperCase();
          this.menuElement = Array.from(this.children).find((element) => {
            return element.tagName === match;
          });
          if (this.menuElement === void 0) {
            this.menuElement = document.createElement(this.menuTag);
            this.appendChild(this.menuElement);
          }
          if (this.menuElement.id === "") {
            this.menuElement.id = uniqueId("listbox-");
          }
          this.menuId = this.menuElement.id;
          this.optionsPlaceholder = document.createComment("");
          this.menuElement.append(this.optionsPlaceholder);
          this.updateMenuConfig();
          DOM.queueUpdate(() => this.initialize());
        }
        disconnectedCallback() {
          super.disconnectedCallback();
          this.toggleFlyout(false);
          this.inputElement.removeEventListener("input", this.handleTextInput);
          this.inputElement.removeEventListener("click", this.handleInputClick);
          if (this.inputElementView !== null) {
            this.inputElementView.dispose();
            this.inputElementView = null;
          }
        }
        /**
         * Move focus to the input element
         * @public
         */
        focus() {
          this.inputElement.focus();
        }
        /**
         * Initialize the component.  This is delayed a frame to ensure children are connected as well.
         */
        initialize() {
          this.updateListItemTemplate();
          this.updateOptionTemplate();
          this.itemsRepeatBehavior = new RepeatDirective((x) => x.selectedItems, (x) => x.activeListItemTemplate, { positioning: true }).createBehavior(this.itemsPlaceholderElement);
          this.inputElement.addEventListener("input", this.handleTextInput);
          this.inputElement.addEventListener("click", this.handleInputClick);
          this.$fastController.addBehaviors([this.itemsRepeatBehavior]);
          this.menuElement.suggestionsAvailableText = this.suggestionsAvailableText;
          this.menuElement.addEventListener("optionsupdated", this.handleMenuOptionsUpdated);
          this.optionsRepeatBehavior = new RepeatDirective((x) => x.filteredOptionsList, (x) => x.activeMenuOptionTemplate, { positioning: true }).createBehavior(this.optionsPlaceholder);
          this.$fastController.addBehaviors([this.optionsRepeatBehavior]);
          this.handleSelectionChange();
        }
        /**
         * Toggles the menu flyout
         */
        toggleFlyout(open) {
          if (this.flyoutOpen === open) {
            return;
          }
          if (open && document.activeElement === this.inputElement) {
            this.flyoutOpen = open;
            DOM.queueUpdate(() => {
              if (this.menuElement !== void 0) {
                this.setFocusedOption(0);
              } else {
                this.disableMenu();
              }
            });
            return;
          }
          this.flyoutOpen = false;
          this.disableMenu();
          return;
        }
        /**
         * Handle the menu options updated event from the child menu
         */
        handleMenuOptionsUpdated(e) {
          e.preventDefault();
          if (this.flyoutOpen) {
            this.setFocusedOption(0);
          }
        }
        /**
         * Handle key down events.
         */
        handleKeyDown(e) {
          if (e.defaultPrevented) {
            return false;
          }
          switch (e.key) {
            // TODO: what should "home" and "end" keys do, exactly?
            //
            // case keyHome: {
            //     if (!this.flyoutOpen) {
            //         this.toggleFlyout(true);
            //     } else {
            //         if (this.menuElement.optionElements.length > 0) {
            //             this.setFocusedOption(0);
            //         }
            //     }
            //     return false;
            // }
            // case keyEnd: {
            //     if (!this.flyoutOpen) {
            //         this.toggleFlyout(true);
            //     } else {
            //         if (this.menuElement.optionElements.length > 0) {
            //             this.toggleFlyout(true);
            //             this.setFocusedOption(this.menuElement.optionElements.length - 1);
            //         }
            //     }
            //     return false;
            // }
            case keyArrowDown: {
              if (!this.flyoutOpen) {
                this.toggleFlyout(true);
              } else {
                const nextFocusOptionIndex = this.flyoutOpen ? Math.min(this.menuFocusIndex + 1, this.menuElement.optionElements.length - 1) : 0;
                this.setFocusedOption(nextFocusOptionIndex);
              }
              return false;
            }
            case keyArrowUp: {
              if (!this.flyoutOpen) {
                this.toggleFlyout(true);
              } else {
                const previousFocusOptionIndex = this.flyoutOpen ? Math.max(this.menuFocusIndex - 1, 0) : 0;
                this.setFocusedOption(previousFocusOptionIndex);
              }
              return false;
            }
            case keyEscape: {
              this.toggleFlyout(false);
              return false;
            }
            case keyEnter: {
              if (this.menuFocusIndex !== -1 && this.menuElement.optionElements.length > this.menuFocusIndex) {
                this.menuElement.optionElements[this.menuFocusIndex].click();
              }
              return false;
            }
            case keyArrowRight: {
              if (document.activeElement !== this.inputElement) {
                this.incrementFocusedItem(1);
                return false;
              }
              return true;
            }
            case keyArrowLeft: {
              if (this.inputElement.selectionStart === 0) {
                this.incrementFocusedItem(-1);
                return false;
              }
              return true;
            }
            case keyDelete:
            case keyBackspace: {
              if (document.activeElement === null) {
                return true;
              }
              if (document.activeElement === this.inputElement) {
                if (this.inputElement.selectionStart === 0) {
                  this.selection = this.selectedItems.slice(0, this.selectedItems.length - 1).toString();
                  this.toggleFlyout(false);
                  return false;
                }
                return true;
              }
              const selectedItems = Array.from(this.listElement.children);
              const currentFocusedItemIndex = selectedItems.indexOf(document.activeElement);
              if (currentFocusedItemIndex > -1) {
                this.selection = this.selectedItems.splice(currentFocusedItemIndex, 1).toString();
                DOM.queueUpdate(() => {
                  selectedItems[Math.min(selectedItems.length, currentFocusedItemIndex)].focus();
                });
                return false;
              }
              return true;
            }
          }
          this.toggleFlyout(true);
          return true;
        }
        /**
         * Handle focus in events.
         */
        handleFocusIn(e) {
          return false;
        }
        /**
         * Handle focus out events.
         */
        handleFocusOut(e) {
          if (this.menuElement === void 0 || !this.menuElement.contains(e.relatedTarget)) {
            this.toggleFlyout(false);
          }
          return false;
        }
        /**
         * The list of selected items has changed
         */
        handleSelectionChange() {
          if (this.selectedItems.toString() === this.selection) {
            return;
          }
          this.selectedItems = this.selection === "" ? [] : this.selection.split(",");
          this.updateFilteredOptions();
          DOM.queueUpdate(() => {
            this.checkMaxItems();
          });
          this.$emit("selectionchange", { bubbles: false });
        }
        /**
         * Anchored region is loaded, menu and options exist in the DOM.
         */
        handleRegionLoaded(e) {
          DOM.queueUpdate(() => {
            this.setFocusedOption(0);
            this.$emit("menuloaded", { bubbles: false });
          });
        }
        /**
         * Checks if the maximum number of items has been chosen and updates the ui.
         */
        checkMaxItems() {
          if (this.inputElement === void 0) {
            return;
          }
          if (this.maxSelected !== void 0 && this.selectedItems.length >= this.maxSelected) {
            if (document.activeElement === this.inputElement) {
              const selectedItemInstances = Array.from(this.listElement.querySelectorAll("[role='listitem']"));
              selectedItemInstances[selectedItemInstances.length - 1].focus();
            }
            this.inputElement.hidden = true;
          } else {
            this.inputElement.hidden = false;
          }
        }
        /**
         * A list item has been invoked.
         */
        handleItemInvoke(e) {
          if (e.defaultPrevented) {
            return false;
          }
          if (e.target instanceof PickerListItem) {
            const listItems = Array.from(this.listElement.querySelectorAll("[role='listitem']"));
            const itemIndex = listItems.indexOf(e.target);
            if (itemIndex !== -1) {
              const newSelection = this.selectedItems.slice();
              newSelection.splice(itemIndex, 1);
              this.selection = newSelection.toString();
              DOM.queueUpdate(() => this.incrementFocusedItem(0));
            }
            return false;
          }
          return true;
        }
        /**
         * A menu option has been invoked.
         */
        handleOptionInvoke(e) {
          if (e.defaultPrevented) {
            return false;
          }
          if (e.target instanceof PickerMenuOption) {
            if (e.target.value !== void 0) {
              this.selection = `${this.selection}${this.selection === "" ? "" : ","}${e.target.value}`;
            }
            this.inputElement.value = "";
            this.query = "";
            this.inputElement.focus();
            this.toggleFlyout(false);
            return false;
          }
          return true;
        }
        /**
         * Increments the focused list item by the specified amount
         */
        incrementFocusedItem(increment) {
          if (this.selectedItems.length === 0) {
            this.inputElement.focus();
            return;
          }
          const selectedItemsAsElements = Array.from(this.listElement.querySelectorAll("[role='listitem']"));
          if (document.activeElement !== null) {
            let currentFocusedItemIndex = selectedItemsAsElements.indexOf(document.activeElement);
            if (currentFocusedItemIndex === -1) {
              currentFocusedItemIndex = selectedItemsAsElements.length;
            }
            const newFocusedItemIndex = Math.min(selectedItemsAsElements.length, Math.max(0, currentFocusedItemIndex + increment));
            if (newFocusedItemIndex === selectedItemsAsElements.length) {
              if (this.maxSelected !== void 0 && this.selectedItems.length >= this.maxSelected) {
                selectedItemsAsElements[newFocusedItemIndex - 1].focus();
              } else {
                this.inputElement.focus();
              }
            } else {
              selectedItemsAsElements[newFocusedItemIndex].focus();
            }
          }
        }
        /**
         * Disables the menu. Note that the menu can be open, just doens't have any valid options on display.
         */
        disableMenu() {
          var _a, _b, _c;
          this.menuFocusIndex = -1;
          this.menuFocusOptionId = void 0;
          (_a = this.inputElement) === null || _a === void 0 ? void 0 : _a.removeAttribute("aria-activedescendant");
          (_b = this.inputElement) === null || _b === void 0 ? void 0 : _b.removeAttribute("aria-owns");
          (_c = this.inputElement) === null || _c === void 0 ? void 0 : _c.removeAttribute("aria-expanded");
        }
        /**
         * Sets the currently focused menu option by index
         */
        setFocusedOption(optionIndex) {
          if (!this.flyoutOpen || optionIndex === -1 || this.showNoOptions || this.showLoading) {
            this.disableMenu();
            return;
          }
          if (this.menuElement.optionElements.length === 0) {
            return;
          }
          this.menuElement.optionElements.forEach((element) => {
            element.setAttribute("aria-selected", "false");
          });
          this.menuFocusIndex = optionIndex;
          if (this.menuFocusIndex > this.menuElement.optionElements.length - 1) {
            this.menuFocusIndex = this.menuElement.optionElements.length - 1;
          }
          this.menuFocusOptionId = this.menuElement.optionElements[this.menuFocusIndex].id;
          this.inputElement.setAttribute("aria-owns", this.menuId);
          this.inputElement.setAttribute("aria-expanded", "true");
          this.inputElement.setAttribute("aria-activedescendant", this.menuFocusOptionId);
          const focusedOption = this.menuElement.optionElements[this.menuFocusIndex];
          focusedOption.setAttribute("aria-selected", "true");
          this.menuElement.scrollTo(0, focusedOption.offsetTop);
        }
        /**
         * Updates the template used for the list item repeat behavior
         */
        updateListItemTemplate() {
          var _a;
          this.activeListItemTemplate = (_a = this.listItemTemplate) !== null && _a !== void 0 ? _a : this.defaultListItemTemplate;
        }
        /**
         * Updates the template used for the menu option repeat behavior
         */
        updateOptionTemplate() {
          var _a;
          this.activeMenuOptionTemplate = (_a = this.menuOptionTemplate) !== null && _a !== void 0 ? _a : this.defaultMenuOptionTemplate;
        }
        /**
         * Updates the filtered options array
         */
        updateFilteredOptions() {
          this.filteredOptionsList = this.optionsList.slice(0);
          if (this.filterSelected) {
            this.filteredOptionsList = this.filteredOptionsList.filter((el) => this.selectedItems.indexOf(el) === -1);
          }
          if (this.filterQuery && this.query !== "" && this.query !== void 0) {
            this.filteredOptionsList = this.filteredOptionsList.filter((el) => el.indexOf(this.query) !== -1);
          }
        }
        /**
         * Updates the menu configuration
         */
        updateMenuConfig() {
          let newConfig = this.configLookup[this.menuPlacement];
          if (newConfig === null) {
            newConfig = FlyoutPosBottomFill;
          }
          this.menuConfig = Object.assign(Object.assign({}, newConfig), { autoUpdateMode: "auto", fixedPlacement: true, horizontalViewportLock: false, verticalViewportLock: false });
        }
      };
      __decorate([
        attr({ attribute: "selection" })
      ], Picker.prototype, "selection", void 0);
      __decorate([
        attr({ attribute: "options" })
      ], Picker.prototype, "options", void 0);
      __decorate([
        attr({ attribute: "filter-selected", mode: "boolean" })
      ], Picker.prototype, "filterSelected", void 0);
      __decorate([
        attr({ attribute: "filter-query", mode: "boolean" })
      ], Picker.prototype, "filterQuery", void 0);
      __decorate([
        attr({ attribute: "max-selected" })
      ], Picker.prototype, "maxSelected", void 0);
      __decorate([
        attr({ attribute: "no-suggestions-text" })
      ], Picker.prototype, "noSuggestionsText", void 0);
      __decorate([
        attr({ attribute: "suggestions-available-text" })
      ], Picker.prototype, "suggestionsAvailableText", void 0);
      __decorate([
        attr({ attribute: "loading-text" })
      ], Picker.prototype, "loadingText", void 0);
      __decorate([
        attr({ attribute: "label" })
      ], Picker.prototype, "label", void 0);
      __decorate([
        attr({ attribute: "labelledby" })
      ], Picker.prototype, "labelledBy", void 0);
      __decorate([
        attr({ attribute: "placeholder" })
      ], Picker.prototype, "placeholder", void 0);
      __decorate([
        attr({ attribute: "menu-placement" })
      ], Picker.prototype, "menuPlacement", void 0);
      __decorate([
        observable
      ], Picker.prototype, "showLoading", void 0);
      __decorate([
        observable
      ], Picker.prototype, "listItemTemplate", void 0);
      __decorate([
        observable
      ], Picker.prototype, "defaultListItemTemplate", void 0);
      __decorate([
        observable
      ], Picker.prototype, "activeListItemTemplate", void 0);
      __decorate([
        observable
      ], Picker.prototype, "menuOptionTemplate", void 0);
      __decorate([
        observable
      ], Picker.prototype, "defaultMenuOptionTemplate", void 0);
      __decorate([
        observable
      ], Picker.prototype, "activeMenuOptionTemplate", void 0);
      __decorate([
        observable
      ], Picker.prototype, "listItemContentsTemplate", void 0);
      __decorate([
        observable
      ], Picker.prototype, "menuOptionContentsTemplate", void 0);
      __decorate([
        observable
      ], Picker.prototype, "optionsList", void 0);
      __decorate([
        observable
      ], Picker.prototype, "query", void 0);
      __decorate([
        observable
      ], Picker.prototype, "filteredOptionsList", void 0);
      __decorate([
        observable
      ], Picker.prototype, "flyoutOpen", void 0);
      __decorate([
        observable
      ], Picker.prototype, "menuId", void 0);
      __decorate([
        observable
      ], Picker.prototype, "selectedListTag", void 0);
      __decorate([
        observable
      ], Picker.prototype, "menuTag", void 0);
      __decorate([
        observable
      ], Picker.prototype, "menuFocusIndex", void 0);
      __decorate([
        observable
      ], Picker.prototype, "menuFocusOptionId", void 0);
      __decorate([
        observable
      ], Picker.prototype, "showNoOptions", void 0);
      __decorate([
        observable
      ], Picker.prototype, "menuConfig", void 0);
      __decorate([
        observable
      ], Picker.prototype, "selectedItems", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-menu.template.js
  var init_picker_menu_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-menu.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-menu-option.template.js
  var init_picker_menu_option_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-menu-option.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-list.template.js
  var init_picker_list_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-list.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-list-item.template.js
  var init_picker_list_item_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/picker-list-item.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/picker/index.js
  var init_picker2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/picker/index.js"() {
      init_picker_template();
      init_picker();
      init_picker_menu_template();
      init_picker_menu();
      init_picker_menu_option_template();
      init_picker_menu_option();
      init_picker_list_template();
      init_picker_list();
      init_picker_list_item_template();
      init_picker_list_item();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/menu-item/menu-item.options.js
  var MenuItemRole, roleForMenuItem;
  var init_menu_item_options = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/menu-item/menu-item.options.js"() {
      MenuItemRole = {
        /**
         * The menu item has a "menuitem" role
         */
        menuitem: "menuitem",
        /**
         * The menu item has a "menuitemcheckbox" role
         */
        menuitemcheckbox: "menuitemcheckbox",
        /**
         * The menu item has a "menuitemradio" role
         */
        menuitemradio: "menuitemradio"
      };
      roleForMenuItem = {
        [MenuItemRole.menuitem]: "menuitem",
        [MenuItemRole.menuitemcheckbox]: "menuitemcheckbox",
        [MenuItemRole.menuitemradio]: "menuitemradio"
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/menu-item/menu-item.js
  var MenuItem;
  var init_menu_item = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/menu-item/menu-item.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_foundation_element();
      init_start_end();
      init_direction();
      init_apply_mixins();
      init_menu_item_options();
      MenuItem = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.role = MenuItemRole.menuitem;
          this.hasSubmenu = false;
          this.currentDirection = Direction.ltr;
          this.focusSubmenuOnLoad = false;
          this.handleMenuItemKeyDown = (e) => {
            if (e.defaultPrevented) {
              return false;
            }
            switch (e.key) {
              case keyEnter:
              case keySpace:
                this.invoke();
                return false;
              case keyArrowRight:
                this.expandAndFocus();
                return false;
              case keyArrowLeft:
                if (this.expanded) {
                  this.expanded = false;
                  this.focus();
                  return false;
                }
            }
            return true;
          };
          this.handleMenuItemClick = (e) => {
            if (e.defaultPrevented || this.disabled) {
              return false;
            }
            this.invoke();
            return false;
          };
          this.submenuLoaded = () => {
            if (!this.focusSubmenuOnLoad) {
              return;
            }
            this.focusSubmenuOnLoad = false;
            if (this.hasSubmenu) {
              this.submenu.focus();
              this.setAttribute("tabindex", "-1");
            }
          };
          this.handleMouseOver = (e) => {
            if (this.disabled || !this.hasSubmenu || this.expanded) {
              return false;
            }
            this.expanded = true;
            return false;
          };
          this.handleMouseOut = (e) => {
            if (!this.expanded || this.contains(document.activeElement)) {
              return false;
            }
            this.expanded = false;
            return false;
          };
          this.expandAndFocus = () => {
            if (!this.hasSubmenu) {
              return;
            }
            this.focusSubmenuOnLoad = true;
            this.expanded = true;
          };
          this.invoke = () => {
            if (this.disabled) {
              return;
            }
            switch (this.role) {
              case MenuItemRole.menuitemcheckbox:
                this.checked = !this.checked;
                break;
              case MenuItemRole.menuitem:
                this.updateSubmenu();
                if (this.hasSubmenu) {
                  this.expandAndFocus();
                } else {
                  this.$emit("change");
                }
                break;
              case MenuItemRole.menuitemradio:
                if (!this.checked) {
                  this.checked = true;
                }
                break;
            }
          };
          this.updateSubmenu = () => {
            this.submenu = this.domChildren().find((element) => {
              return element.getAttribute("role") === "menu";
            });
            this.hasSubmenu = this.submenu === void 0 ? false : true;
          };
        }
        expandedChanged(oldValue) {
          if (this.$fastController.isConnected) {
            if (this.submenu === void 0) {
              return;
            }
            if (this.expanded === false) {
              this.submenu.collapseExpandedItem();
            } else {
              this.currentDirection = getDirection(this);
            }
            this.$emit("expanded-change", this, { bubbles: false });
          }
        }
        checkedChanged(oldValue, newValue) {
          if (this.$fastController.isConnected) {
            this.$emit("change");
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          DOM.queueUpdate(() => {
            this.updateSubmenu();
          });
          if (!this.startColumnCount) {
            this.startColumnCount = 1;
          }
          this.observer = new MutationObserver(this.updateSubmenu);
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          super.disconnectedCallback();
          this.submenu = void 0;
          if (this.observer !== void 0) {
            this.observer.disconnect();
            this.observer = void 0;
          }
        }
        /**
         * get an array of valid DOM children
         */
        domChildren() {
          return Array.from(this.children).filter((child) => !child.hasAttribute("hidden"));
        }
      };
      __decorate([
        attr({ mode: "boolean" })
      ], MenuItem.prototype, "disabled", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], MenuItem.prototype, "expanded", void 0);
      __decorate([
        observable
      ], MenuItem.prototype, "startColumnCount", void 0);
      __decorate([
        attr
      ], MenuItem.prototype, "role", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], MenuItem.prototype, "checked", void 0);
      __decorate([
        observable
      ], MenuItem.prototype, "submenuRegion", void 0);
      __decorate([
        observable
      ], MenuItem.prototype, "hasSubmenu", void 0);
      __decorate([
        observable
      ], MenuItem.prototype, "currentDirection", void 0);
      __decorate([
        observable
      ], MenuItem.prototype, "submenu", void 0);
      applyMixins(MenuItem, StartEnd);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/menu-item/menu-item.template.js
  var init_menu_item_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/menu-item/menu-item.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/menu-item/index.js
  var init_menu_item2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/menu-item/index.js"() {
      init_menu_item_template();
      init_menu_item();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/menu/menu.template.js
  var init_menu_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/menu/menu.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/menu/menu.js
  var Menu;
  var init_menu = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/menu/menu.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_menu_item2();
      init_foundation_element();
      Menu = class _Menu extends FoundationElement {
        constructor() {
          super(...arguments);
          this.expandedItem = null;
          this.focusIndex = -1;
          this.isNestedMenu = () => {
            return this.parentElement !== null && isHTMLElement(this.parentElement) && this.parentElement.getAttribute("role") === "menuitem";
          };
          this.handleFocusOut = (e) => {
            if (!this.contains(e.relatedTarget) && this.menuItems !== void 0) {
              this.collapseExpandedItem();
              const focusIndex = this.menuItems.findIndex(this.isFocusableElement);
              this.menuItems[this.focusIndex].setAttribute("tabindex", "-1");
              this.menuItems[focusIndex].setAttribute("tabindex", "0");
              this.focusIndex = focusIndex;
            }
          };
          this.handleItemFocus = (e) => {
            const targetItem = e.target;
            if (this.menuItems !== void 0 && targetItem !== this.menuItems[this.focusIndex]) {
              this.menuItems[this.focusIndex].setAttribute("tabindex", "-1");
              this.focusIndex = this.menuItems.indexOf(targetItem);
              targetItem.setAttribute("tabindex", "0");
            }
          };
          this.handleExpandedChanged = (e) => {
            if (e.defaultPrevented || e.target === null || this.menuItems === void 0 || this.menuItems.indexOf(e.target) < 0) {
              return;
            }
            e.preventDefault();
            const changedItem = e.target;
            if (this.expandedItem !== null && changedItem === this.expandedItem && changedItem.expanded === false) {
              this.expandedItem = null;
              return;
            }
            if (changedItem.expanded) {
              if (this.expandedItem !== null && this.expandedItem !== changedItem) {
                this.expandedItem.expanded = false;
              }
              this.menuItems[this.focusIndex].setAttribute("tabindex", "-1");
              this.expandedItem = changedItem;
              this.focusIndex = this.menuItems.indexOf(changedItem);
              changedItem.setAttribute("tabindex", "0");
            }
          };
          this.removeItemListeners = () => {
            if (this.menuItems !== void 0) {
              this.menuItems.forEach((item) => {
                item.removeEventListener("expanded-change", this.handleExpandedChanged);
                item.removeEventListener("focus", this.handleItemFocus);
              });
            }
          };
          this.setItems = () => {
            const newItems = this.domChildren();
            this.removeItemListeners();
            this.menuItems = newItems;
            const menuItems = this.menuItems.filter(this.isMenuItemElement);
            if (menuItems.length) {
              this.focusIndex = 0;
            }
            function elementIndent(el) {
              const role = el.getAttribute("role");
              const startSlot = el.querySelector("[slot=start]");
              if (role !== MenuItemRole.menuitem && startSlot === null) {
                return 1;
              } else if (role === MenuItemRole.menuitem && startSlot !== null) {
                return 1;
              } else if (role !== MenuItemRole.menuitem && startSlot !== null) {
                return 2;
              } else {
                return 0;
              }
            }
            const indent = menuItems.reduce((accum, current) => {
              const elementValue = elementIndent(current);
              return accum > elementValue ? accum : elementValue;
            }, 0);
            menuItems.forEach((item, index) => {
              item.setAttribute("tabindex", index === 0 ? "0" : "-1");
              item.addEventListener("expanded-change", this.handleExpandedChanged);
              item.addEventListener("focus", this.handleItemFocus);
              if (item instanceof MenuItem || "startColumnCount" in item) {
                item.startColumnCount = indent;
              }
            });
          };
          this.changeHandler = (e) => {
            if (this.menuItems === void 0) {
              return;
            }
            const changedMenuItem = e.target;
            const changeItemIndex = this.menuItems.indexOf(changedMenuItem);
            if (changeItemIndex === -1) {
              return;
            }
            if (changedMenuItem.role === "menuitemradio" && changedMenuItem.checked === true) {
              for (let i = changeItemIndex - 1; i >= 0; --i) {
                const item = this.menuItems[i];
                const role = item.getAttribute("role");
                if (role === MenuItemRole.menuitemradio) {
                  item.checked = false;
                }
                if (role === "separator") {
                  break;
                }
              }
              const maxIndex = this.menuItems.length - 1;
              for (let i = changeItemIndex + 1; i <= maxIndex; ++i) {
                const item = this.menuItems[i];
                const role = item.getAttribute("role");
                if (role === MenuItemRole.menuitemradio) {
                  item.checked = false;
                }
                if (role === "separator") {
                  break;
                }
              }
            }
          };
          this.isMenuItemElement = (el) => {
            return isHTMLElement(el) && _Menu.focusableElementRoles.hasOwnProperty(el.getAttribute("role"));
          };
          this.isFocusableElement = (el) => {
            return this.isMenuItemElement(el);
          };
        }
        itemsChanged(oldValue, newValue) {
          if (this.$fastController.isConnected && this.menuItems !== void 0) {
            this.setItems();
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          DOM.queueUpdate(() => {
            this.setItems();
          });
          this.addEventListener("change", this.changeHandler);
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          super.disconnectedCallback();
          this.removeItemListeners();
          this.menuItems = void 0;
          this.removeEventListener("change", this.changeHandler);
        }
        /**
         * Focuses the first item in the menu.
         *
         * @public
         */
        focus() {
          this.setFocus(0, 1);
        }
        /**
         * Collapses any expanded menu items.
         *
         * @public
         */
        collapseExpandedItem() {
          if (this.expandedItem !== null) {
            this.expandedItem.expanded = false;
            this.expandedItem = null;
          }
        }
        /**
         * @internal
         */
        handleMenuKeyDown(e) {
          if (e.defaultPrevented || this.menuItems === void 0) {
            return;
          }
          switch (e.key) {
            case keyArrowDown:
              this.setFocus(this.focusIndex + 1, 1);
              return;
            case keyArrowUp:
              this.setFocus(this.focusIndex - 1, -1);
              return;
            case keyEnd:
              this.setFocus(this.menuItems.length - 1, -1);
              return;
            case keyHome:
              this.setFocus(0, 1);
              return;
            default:
              return true;
          }
        }
        /**
         * get an array of valid DOM children
         */
        domChildren() {
          return Array.from(this.children).filter((child) => !child.hasAttribute("hidden"));
        }
        setFocus(focusIndex, adjustment) {
          if (this.menuItems === void 0) {
            return;
          }
          while (focusIndex >= 0 && focusIndex < this.menuItems.length) {
            const child = this.menuItems[focusIndex];
            if (this.isFocusableElement(child)) {
              if (this.focusIndex > -1 && this.menuItems.length >= this.focusIndex - 1) {
                this.menuItems[this.focusIndex].setAttribute("tabindex", "-1");
              }
              this.focusIndex = focusIndex;
              child.setAttribute("tabindex", "0");
              child.focus();
              break;
            }
            focusIndex += adjustment;
          }
        }
      };
      Menu.focusableElementRoles = roleForMenuItem;
      __decorate([
        observable
      ], Menu.prototype, "items", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/menu/index.js
  var init_menu2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/menu/index.js"() {
      init_menu_template();
      init_menu();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/number-field/number-field.template.js
  var init_number_field_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/number-field/number-field.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/text-field/text-field.form-associated.js
  var _TextField, FormAssociatedTextField;
  var init_text_field_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/text-field/text-field.form-associated.js"() {
      init_form_associated();
      init_foundation_element();
      _TextField = class extends FoundationElement {
      };
      FormAssociatedTextField = class extends FormAssociated(_TextField) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("input");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/text-field/text-field.options.js
  var TextFieldType;
  var init_text_field_options = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/text-field/text-field.options.js"() {
      TextFieldType = {
        /**
         * An email TextField
         */
        email: "email",
        /**
         * A password TextField
         */
        password: "password",
        /**
         * A telephone TextField
         */
        tel: "tel",
        /**
         * A text TextField
         */
        text: "text",
        /**
         * A URL TextField
         */
        url: "url"
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/text-field/text-field.js
  var TextField, DelegatesARIATextbox;
  var init_text_field = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/text-field/text-field.js"() {
      init_tslib_es6();
      init_esm();
      init_patterns();
      init_apply_mixins();
      init_text_field_form_associated();
      init_text_field_options();
      TextField = class extends FormAssociatedTextField {
        constructor() {
          super(...arguments);
          this.type = TextFieldType.text;
        }
        readOnlyChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.readOnly = this.readOnly;
            this.validate();
          }
        }
        autofocusChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.autofocus = this.autofocus;
            this.validate();
          }
        }
        placeholderChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.placeholder = this.placeholder;
          }
        }
        typeChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.type = this.type;
            this.validate();
          }
        }
        listChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.setAttribute("list", this.list);
            this.validate();
          }
        }
        maxlengthChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.maxLength = this.maxlength;
            this.validate();
          }
        }
        minlengthChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.minLength = this.minlength;
            this.validate();
          }
        }
        patternChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.pattern = this.pattern;
            this.validate();
          }
        }
        sizeChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.size = this.size;
          }
        }
        spellcheckChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.spellcheck = this.spellcheck;
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.proxy.setAttribute("type", this.type);
          this.validate();
          if (this.autofocus) {
            DOM.queueUpdate(() => {
              this.focus();
            });
          }
        }
        /**
         * Selects all the text in the text field
         *
         * @public
         */
        select() {
          this.control.select();
          this.$emit("select");
        }
        /**
         * Handles the internal control's `input` event
         * @internal
         */
        handleTextInput() {
          this.value = this.control.value;
        }
        /**
         * Change event handler for inner control.
         * @remarks
         * "Change" events are not `composable` so they will not
         * permeate the shadow DOM boundary. This fn effectively proxies
         * the change event, emitting a `change` event whenever the internal
         * control emits a `change` event
         * @internal
         */
        handleChange() {
          this.$emit("change");
        }
        /** {@inheritDoc (FormAssociated:interface).validate} */
        validate() {
          super.validate(this.control);
        }
      };
      __decorate([
        attr({ attribute: "readonly", mode: "boolean" })
      ], TextField.prototype, "readOnly", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], TextField.prototype, "autofocus", void 0);
      __decorate([
        attr
      ], TextField.prototype, "placeholder", void 0);
      __decorate([
        attr
      ], TextField.prototype, "type", void 0);
      __decorate([
        attr
      ], TextField.prototype, "list", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], TextField.prototype, "maxlength", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], TextField.prototype, "minlength", void 0);
      __decorate([
        attr
      ], TextField.prototype, "pattern", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], TextField.prototype, "size", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], TextField.prototype, "spellcheck", void 0);
      __decorate([
        observable
      ], TextField.prototype, "defaultSlottedNodes", void 0);
      DelegatesARIATextbox = class {
      };
      applyMixins(DelegatesARIATextbox, ARIAGlobalStatesAndProperties);
      applyMixins(TextField, StartEnd, DelegatesARIATextbox);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/number-field/number-field.form-associated.js
  var _NumberField, FormAssociatedNumberField;
  var init_number_field_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/number-field/number-field.form-associated.js"() {
      init_form_associated();
      init_foundation_element();
      _NumberField = class extends FoundationElement {
      };
      FormAssociatedNumberField = class extends FormAssociated(_NumberField) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("input");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/number-field/number-field.js
  var NumberField;
  var init_number_field = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/number-field/number-field.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_start_end();
      init_apply_mixins();
      init_text_field();
      init_number_field_form_associated();
      NumberField = class extends FormAssociatedNumberField {
        constructor() {
          super(...arguments);
          this.hideStep = false;
          this.step = 1;
          this.isUserInput = false;
        }
        /**
         * Ensures that the max is greater than the min and that the value
         *  is less than the max
         * @param previous - the previous max value
         * @param next - updated max value
         *
         * @internal
         */
        maxChanged(previous, next) {
          var _a;
          this.max = Math.max(next, (_a = this.min) !== null && _a !== void 0 ? _a : next);
          const min = Math.min(this.min, this.max);
          if (this.min !== void 0 && this.min !== min) {
            this.min = min;
          }
          this.value = this.getValidValue(this.value);
        }
        /**
         * Ensures that the min is less than the max and that the value
         *  is greater than the min
         * @param previous - previous min value
         * @param next - updated min value
         *
         * @internal
         */
        minChanged(previous, next) {
          var _a;
          this.min = Math.min(next, (_a = this.max) !== null && _a !== void 0 ? _a : next);
          const max = Math.max(this.min, this.max);
          if (this.max !== void 0 && this.max !== max) {
            this.max = max;
          }
          this.value = this.getValidValue(this.value);
        }
        /**
         * The value property, typed as a number.
         *
         * @public
         */
        get valueAsNumber() {
          return parseFloat(super.value);
        }
        set valueAsNumber(next) {
          this.value = next.toString();
        }
        /**
         * Validates that the value is a number between the min and max
         * @param previous - previous stored value
         * @param next - value being updated
         * @param updateControl - should the text field be updated with value, defaults to true
         * @internal
         */
        valueChanged(previous, next) {
          this.value = this.getValidValue(next);
          if (next !== this.value) {
            return;
          }
          if (this.control && !this.isUserInput) {
            this.control.value = this.value;
          }
          super.valueChanged(previous, this.value);
          if (previous !== void 0 && !this.isUserInput) {
            this.$emit("input");
            this.$emit("change");
          }
          this.isUserInput = false;
        }
        /** {@inheritDoc (FormAssociated:interface).validate} */
        validate() {
          super.validate(this.control);
        }
        /**
         * Sets the internal value to a valid number between the min and max properties
         * @param value - user input
         *
         * @internal
         */
        getValidValue(value) {
          var _a, _b;
          let validValue = parseFloat(parseFloat(value).toPrecision(12));
          if (isNaN(validValue)) {
            validValue = "";
          } else {
            validValue = Math.min(validValue, (_a = this.max) !== null && _a !== void 0 ? _a : validValue);
            validValue = Math.max(validValue, (_b = this.min) !== null && _b !== void 0 ? _b : validValue).toString();
          }
          return validValue;
        }
        /**
         * Increments the value using the step value
         *
         * @public
         */
        stepUp() {
          const value = parseFloat(this.value);
          const stepUpValue = !isNaN(value) ? value + this.step : this.min > 0 ? this.min : this.max < 0 ? this.max : !this.min ? this.step : 0;
          this.value = stepUpValue.toString();
        }
        /**
         * Decrements the value using the step value
         *
         * @public
         */
        stepDown() {
          const value = parseFloat(this.value);
          const stepDownValue = !isNaN(value) ? value - this.step : this.min > 0 ? this.min : this.max < 0 ? this.max : !this.min ? 0 - this.step : 0;
          this.value = stepDownValue.toString();
        }
        /**
         * Sets up the initial state of the number field
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.proxy.setAttribute("type", "number");
          this.validate();
          this.control.value = this.value;
          if (this.autofocus) {
            DOM.queueUpdate(() => {
              this.focus();
            });
          }
        }
        /**
         * Selects all the text in the number field
         *
         * @public
         */
        select() {
          this.control.select();
          this.$emit("select");
        }
        /**
         * Handles the internal control's `input` event
         * @internal
         */
        handleTextInput() {
          this.control.value = this.control.value.replace(/[^0-9\-+e.]/g, "");
          this.isUserInput = true;
          this.value = this.control.value;
        }
        /**
         * Change event handler for inner control.
         * @remarks
         * "Change" events are not `composable` so they will not
         * permeate the shadow DOM boundary. This fn effectively proxies
         * the change event, emitting a `change` event whenever the internal
         * control emits a `change` event
         * @internal
         */
        handleChange() {
          this.$emit("change");
        }
        /**
         * Handles the internal control's `keydown` event
         * @internal
         */
        handleKeyDown(e) {
          const key = e.key;
          switch (key) {
            case keyArrowUp:
              this.stepUp();
              return false;
            case keyArrowDown:
              this.stepDown();
              return false;
          }
          return true;
        }
        /**
         * Handles populating the input field with a validated value when
         *  leaving the input field.
         * @internal
         */
        handleBlur() {
          this.control.value = this.value;
        }
      };
      __decorate([
        attr({ attribute: "readonly", mode: "boolean" })
      ], NumberField.prototype, "readOnly", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], NumberField.prototype, "autofocus", void 0);
      __decorate([
        attr({ attribute: "hide-step", mode: "boolean" })
      ], NumberField.prototype, "hideStep", void 0);
      __decorate([
        attr
      ], NumberField.prototype, "placeholder", void 0);
      __decorate([
        attr
      ], NumberField.prototype, "list", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], NumberField.prototype, "maxlength", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], NumberField.prototype, "minlength", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], NumberField.prototype, "size", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], NumberField.prototype, "step", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], NumberField.prototype, "max", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], NumberField.prototype, "min", void 0);
      __decorate([
        observable
      ], NumberField.prototype, "defaultSlottedNodes", void 0);
      applyMixins(NumberField, StartEnd, DelegatesARIATextbox);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/number-field/index.js
  var init_number_field2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/number-field/index.js"() {
      init_number_field_template();
      init_number_field();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/progress-ring/progress-ring.template.js
  var progressSegments, progressRingTemplate;
  var init_progress_ring_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/progress-ring/progress-ring.template.js"() {
      init_esm();
      progressSegments = 44;
      progressRingTemplate = (context, definition) => html`
    <template
        role="progressbar"
        aria-valuenow="${(x) => x.value}"
        aria-valuemin="${(x) => x.min}"
        aria-valuemax="${(x) => x.max}"
        class="${(x) => x.paused ? "paused" : ""}"
    >
        ${when((x) => typeof x.value === "number", html`
                <svg
                    class="progress"
                    part="progress"
                    viewBox="0 0 16 16"
                    slot="determinate"
                >
                    <circle
                        class="background"
                        part="background"
                        cx="8px"
                        cy="8px"
                        r="7px"
                    ></circle>
                    <circle
                        class="determinate"
                        part="determinate"
                        style="stroke-dasharray: ${(x) => progressSegments * x.percentComplete / 100}px ${progressSegments}px"
                        cx="8px"
                        cy="8px"
                        r="7px"
                    ></circle>
                </svg>
            `, html`
                <slot name="indeterminate" slot="indeterminate">
                    ${definition.indeterminateIndicator || ""}
                </slot>
            `)}
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/progress-ring/index.js
  var init_progress_ring = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/progress-ring/index.js"() {
      init_progress_ring_template();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/progress/base-progress.js
  var BaseProgress;
  var init_base_progress = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/progress/base-progress.js"() {
      init_tslib_es6();
      init_esm();
      init_foundation_element();
      BaseProgress = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.percentComplete = 0;
        }
        valueChanged() {
          if (this.$fastController.isConnected) {
            this.updatePercentComplete();
          }
        }
        minChanged() {
          if (this.$fastController.isConnected) {
            this.updatePercentComplete();
          }
        }
        maxChanged() {
          if (this.$fastController.isConnected) {
            this.updatePercentComplete();
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.updatePercentComplete();
        }
        updatePercentComplete() {
          const min = typeof this.min === "number" ? this.min : 0;
          const max = typeof this.max === "number" ? this.max : 100;
          const value = typeof this.value === "number" ? this.value : 0;
          const range2 = max - min;
          this.percentComplete = range2 === 0 ? 0 : Math.fround((value - min) / range2 * 100);
        }
      };
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], BaseProgress.prototype, "value", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], BaseProgress.prototype, "min", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], BaseProgress.prototype, "max", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], BaseProgress.prototype, "paused", void 0);
      __decorate([
        observable
      ], BaseProgress.prototype, "percentComplete", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/progress/progress.template.js
  var init_progress_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/progress/progress.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/progress/index.js
  var init_progress = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/progress/index.js"() {
      init_base_progress();
      init_progress_template();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/radio-group/radio-group.template.js
  var radioGroupTemplate;
  var init_radio_group_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/radio-group/radio-group.template.js"() {
      init_esm();
      init_dist2();
      radioGroupTemplate = (context, definition) => html`
    <template
        role="radiogroup"
        aria-disabled="${(x) => x.disabled}"
        aria-readonly="${(x) => x.readOnly}"
        @click="${(x, c) => x.clickHandler(c.event)}"
        @keydown="${(x, c) => x.keydownHandler(c.event)}"
        @focusout="${(x, c) => x.focusOutHandler(c.event)}"
    >
        <slot name="label"></slot>
        <div
            class="positioning-region ${(x) => x.orientation === Orientation.horizontal ? "horizontal" : "vertical"}"
            part="positioning-region"
        >
            <slot
                ${slotted({
        property: "slottedRadioButtons",
        filter: elements("[role=radio]")
      })}
            ></slot>
        </div>
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/radio-group/radio-group.js
  var RadioGroup;
  var init_radio_group = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/radio-group/radio-group.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_direction();
      init_foundation_element();
      RadioGroup = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.orientation = Orientation.horizontal;
          this.radioChangeHandler = (e) => {
            const changedRadio = e.target;
            if (changedRadio.checked) {
              this.slottedRadioButtons.forEach((radio) => {
                if (radio !== changedRadio) {
                  radio.checked = false;
                  if (!this.isInsideFoundationToolbar) {
                    radio.setAttribute("tabindex", "-1");
                  }
                }
              });
              this.selectedRadio = changedRadio;
              this.value = changedRadio.value;
              changedRadio.setAttribute("tabindex", "0");
              this.focusedRadio = changedRadio;
            }
            e.stopPropagation();
          };
          this.moveToRadioByIndex = (group, index) => {
            const radio = group[index];
            if (!this.isInsideToolbar) {
              radio.setAttribute("tabindex", "0");
              if (radio.readOnly) {
                this.slottedRadioButtons.forEach((nextRadio) => {
                  if (nextRadio !== radio) {
                    nextRadio.setAttribute("tabindex", "-1");
                  }
                });
              } else {
                radio.checked = true;
                this.selectedRadio = radio;
              }
            }
            this.focusedRadio = radio;
            radio.focus();
          };
          this.moveRightOffGroup = () => {
            var _a;
            (_a = this.nextElementSibling) === null || _a === void 0 ? void 0 : _a.focus();
          };
          this.moveLeftOffGroup = () => {
            var _a;
            (_a = this.previousElementSibling) === null || _a === void 0 ? void 0 : _a.focus();
          };
          this.focusOutHandler = (e) => {
            const group = this.slottedRadioButtons;
            const radio = e.target;
            const index = radio !== null ? group.indexOf(radio) : 0;
            const focusedIndex = this.focusedRadio ? group.indexOf(this.focusedRadio) : -1;
            if (focusedIndex === 0 && index === focusedIndex || focusedIndex === group.length - 1 && focusedIndex === index) {
              if (!this.selectedRadio) {
                this.focusedRadio = group[0];
                this.focusedRadio.setAttribute("tabindex", "0");
                group.forEach((nextRadio) => {
                  if (nextRadio !== this.focusedRadio) {
                    nextRadio.setAttribute("tabindex", "-1");
                  }
                });
              } else {
                this.focusedRadio = this.selectedRadio;
                if (!this.isInsideFoundationToolbar) {
                  this.selectedRadio.setAttribute("tabindex", "0");
                  group.forEach((nextRadio) => {
                    if (nextRadio !== this.selectedRadio) {
                      nextRadio.setAttribute("tabindex", "-1");
                    }
                  });
                }
              }
            }
            return true;
          };
          this.clickHandler = (e) => {
            const radio = e.target;
            if (radio) {
              const group = this.slottedRadioButtons;
              if (radio.checked || group.indexOf(radio) === 0) {
                radio.setAttribute("tabindex", "0");
                this.selectedRadio = radio;
              } else {
                radio.setAttribute("tabindex", "-1");
                this.selectedRadio = null;
              }
              this.focusedRadio = radio;
            }
            e.preventDefault();
          };
          this.shouldMoveOffGroupToTheRight = (index, group, key) => {
            return index === group.length && this.isInsideToolbar && key === keyArrowRight;
          };
          this.shouldMoveOffGroupToTheLeft = (group, key) => {
            const index = this.focusedRadio ? group.indexOf(this.focusedRadio) - 1 : 0;
            return index < 0 && this.isInsideToolbar && key === keyArrowLeft;
          };
          this.checkFocusedRadio = () => {
            if (this.focusedRadio !== null && !this.focusedRadio.readOnly && !this.focusedRadio.checked) {
              this.focusedRadio.checked = true;
              this.focusedRadio.setAttribute("tabindex", "0");
              this.focusedRadio.focus();
              this.selectedRadio = this.focusedRadio;
            }
          };
          this.moveRight = (e) => {
            const group = this.slottedRadioButtons;
            let index = 0;
            index = this.focusedRadio ? group.indexOf(this.focusedRadio) + 1 : 1;
            if (this.shouldMoveOffGroupToTheRight(index, group, e.key)) {
              this.moveRightOffGroup();
              return;
            } else if (index === group.length) {
              index = 0;
            }
            while (index < group.length && group.length > 1) {
              if (!group[index].disabled) {
                this.moveToRadioByIndex(group, index);
                break;
              } else if (this.focusedRadio && index === group.indexOf(this.focusedRadio)) {
                break;
              } else if (index + 1 >= group.length) {
                if (this.isInsideToolbar) {
                  break;
                } else {
                  index = 0;
                }
              } else {
                index += 1;
              }
            }
          };
          this.moveLeft = (e) => {
            const group = this.slottedRadioButtons;
            let index = 0;
            index = this.focusedRadio ? group.indexOf(this.focusedRadio) - 1 : 0;
            index = index < 0 ? group.length - 1 : index;
            if (this.shouldMoveOffGroupToTheLeft(group, e.key)) {
              this.moveLeftOffGroup();
              return;
            }
            while (index >= 0 && group.length > 1) {
              if (!group[index].disabled) {
                this.moveToRadioByIndex(group, index);
                break;
              } else if (this.focusedRadio && index === group.indexOf(this.focusedRadio)) {
                break;
              } else if (index - 1 < 0) {
                index = group.length - 1;
              } else {
                index -= 1;
              }
            }
          };
          this.keydownHandler = (e) => {
            const key = e.key;
            if (key in ArrowKeys && this.isInsideFoundationToolbar) {
              return true;
            }
            switch (key) {
              case keyEnter: {
                this.checkFocusedRadio();
                break;
              }
              case keyArrowRight:
              case keyArrowDown: {
                if (this.direction === Direction.ltr) {
                  this.moveRight(e);
                } else {
                  this.moveLeft(e);
                }
                break;
              }
              case keyArrowLeft:
              case keyArrowUp: {
                if (this.direction === Direction.ltr) {
                  this.moveLeft(e);
                } else {
                  this.moveRight(e);
                }
                break;
              }
              default: {
                return true;
              }
            }
          };
        }
        readOnlyChanged() {
          if (this.slottedRadioButtons !== void 0) {
            this.slottedRadioButtons.forEach((radio) => {
              if (this.readOnly) {
                radio.readOnly = true;
              } else {
                radio.readOnly = false;
              }
            });
          }
        }
        disabledChanged() {
          if (this.slottedRadioButtons !== void 0) {
            this.slottedRadioButtons.forEach((radio) => {
              if (this.disabled) {
                radio.disabled = true;
              } else {
                radio.disabled = false;
              }
            });
          }
        }
        nameChanged() {
          if (this.slottedRadioButtons) {
            this.slottedRadioButtons.forEach((radio) => {
              radio.setAttribute("name", this.name);
            });
          }
        }
        valueChanged() {
          if (this.slottedRadioButtons) {
            this.slottedRadioButtons.forEach((radio) => {
              if (radio.value === this.value) {
                radio.checked = true;
                this.selectedRadio = radio;
              }
            });
          }
          this.$emit("change");
        }
        slottedRadioButtonsChanged(oldValue, newValue) {
          if (this.slottedRadioButtons && this.slottedRadioButtons.length > 0) {
            this.setupRadioButtons();
          }
        }
        get parentToolbar() {
          return this.closest('[role="toolbar"]');
        }
        get isInsideToolbar() {
          var _a;
          return (_a = this.parentToolbar) !== null && _a !== void 0 ? _a : false;
        }
        get isInsideFoundationToolbar() {
          var _a;
          return !!((_a = this.parentToolbar) === null || _a === void 0 ? void 0 : _a["$fastController"]);
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.direction = getDirection(this);
          this.setupRadioButtons();
        }
        disconnectedCallback() {
          this.slottedRadioButtons.forEach((radio) => {
            radio.removeEventListener("change", this.radioChangeHandler);
          });
        }
        setupRadioButtons() {
          const checkedRadios = this.slottedRadioButtons.filter((radio) => {
            return radio.hasAttribute("checked");
          });
          const numberOfCheckedRadios = checkedRadios ? checkedRadios.length : 0;
          if (numberOfCheckedRadios > 1) {
            const lastCheckedRadio = checkedRadios[numberOfCheckedRadios - 1];
            lastCheckedRadio.checked = true;
          }
          let foundMatchingVal = false;
          this.slottedRadioButtons.forEach((radio) => {
            if (this.name !== void 0) {
              radio.setAttribute("name", this.name);
            }
            if (this.disabled) {
              radio.disabled = true;
            }
            if (this.readOnly) {
              radio.readOnly = true;
            }
            if (this.value && this.value === radio.value) {
              this.selectedRadio = radio;
              this.focusedRadio = radio;
              radio.checked = true;
              radio.setAttribute("tabindex", "0");
              foundMatchingVal = true;
            } else {
              if (!this.isInsideFoundationToolbar) {
                radio.setAttribute("tabindex", "-1");
              }
              radio.checked = false;
            }
            radio.addEventListener("change", this.radioChangeHandler);
          });
          if (this.value === void 0 && this.slottedRadioButtons.length > 0) {
            const checkedRadios2 = this.slottedRadioButtons.filter((radio) => {
              return radio.hasAttribute("checked");
            });
            const numberOfCheckedRadios2 = checkedRadios2 !== null ? checkedRadios2.length : 0;
            if (numberOfCheckedRadios2 > 0 && !foundMatchingVal) {
              const lastCheckedRadio = checkedRadios2[numberOfCheckedRadios2 - 1];
              lastCheckedRadio.checked = true;
              this.focusedRadio = lastCheckedRadio;
              lastCheckedRadio.setAttribute("tabindex", "0");
            } else {
              this.slottedRadioButtons[0].setAttribute("tabindex", "0");
              this.focusedRadio = this.slottedRadioButtons[0];
            }
          }
        }
      };
      __decorate([
        attr({ attribute: "readonly", mode: "boolean" })
      ], RadioGroup.prototype, "readOnly", void 0);
      __decorate([
        attr({ attribute: "disabled", mode: "boolean" })
      ], RadioGroup.prototype, "disabled", void 0);
      __decorate([
        attr
      ], RadioGroup.prototype, "name", void 0);
      __decorate([
        attr
      ], RadioGroup.prototype, "value", void 0);
      __decorate([
        attr
      ], RadioGroup.prototype, "orientation", void 0);
      __decorate([
        observable
      ], RadioGroup.prototype, "childItems", void 0);
      __decorate([
        observable
      ], RadioGroup.prototype, "slottedRadioButtons", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/radio-group/index.js
  var init_radio_group2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/radio-group/index.js"() {
      init_radio_group_template();
      init_radio_group();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/radio/radio.template.js
  var radioTemplate;
  var init_radio_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/radio/radio.template.js"() {
      init_esm();
      radioTemplate = (context, definition) => html`
    <template
        role="radio"
        class="${(x) => x.checked ? "checked" : ""} ${(x) => x.readOnly ? "readonly" : ""}"
        aria-checked="${(x) => x.checked}"
        aria-required="${(x) => x.required}"
        aria-disabled="${(x) => x.disabled}"
        aria-readonly="${(x) => x.readOnly}"
        @keypress="${(x, c) => x.keypressHandler(c.event)}"
        @click="${(x, c) => x.clickHandler(c.event)}"
    >
        <div part="control" class="control">
            <slot name="checked-indicator">
                ${definition.checkedIndicator || ""}
            </slot>
        </div>
        <label
            part="label"
            class="${(x) => x.defaultSlottedNodes && x.defaultSlottedNodes.length ? "label" : "label label__hidden"}"
        >
            <slot ${slotted("defaultSlottedNodes")}></slot>
        </label>
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/radio/radio.form-associated.js
  var _Radio, FormAssociatedRadio;
  var init_radio_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/radio/radio.form-associated.js"() {
      init_form_associated();
      init_foundation_element();
      _Radio = class extends FoundationElement {
      };
      FormAssociatedRadio = class extends CheckableFormAssociated(_Radio) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("input");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/radio/radio.js
  var Radio;
  var init_radio = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/radio/radio.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_radio_form_associated();
      Radio = class extends FormAssociatedRadio {
        constructor() {
          super();
          this.initialValue = "on";
          this.keypressHandler = (e) => {
            switch (e.key) {
              case keySpace:
                if (!this.checked && !this.readOnly) {
                  this.checked = true;
                }
                return;
            }
            return true;
          };
          this.proxy.setAttribute("type", "radio");
        }
        readOnlyChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.readOnly = this.readOnly;
          }
        }
        /**
         * @internal
         */
        defaultCheckedChanged() {
          var _a;
          if (this.$fastController.isConnected && !this.dirtyChecked) {
            if (!this.isInsideRadioGroup()) {
              this.checked = (_a = this.defaultChecked) !== null && _a !== void 0 ? _a : false;
              this.dirtyChecked = false;
            }
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          var _a, _b;
          super.connectedCallback();
          this.validate();
          if (((_a = this.parentElement) === null || _a === void 0 ? void 0 : _a.getAttribute("role")) !== "radiogroup" && this.getAttribute("tabindex") === null) {
            if (!this.disabled) {
              this.setAttribute("tabindex", "0");
            }
          }
          if (this.checkedAttribute) {
            if (!this.dirtyChecked) {
              if (!this.isInsideRadioGroup()) {
                this.checked = (_b = this.defaultChecked) !== null && _b !== void 0 ? _b : false;
                this.dirtyChecked = false;
              }
            }
          }
        }
        isInsideRadioGroup() {
          const parent = this.closest("[role=radiogroup]");
          return parent !== null;
        }
        /**
         * @internal
         */
        clickHandler(e) {
          if (!this.disabled && !this.readOnly && !this.checked) {
            this.checked = true;
          }
        }
      };
      __decorate([
        attr({ attribute: "readonly", mode: "boolean" })
      ], Radio.prototype, "readOnly", void 0);
      __decorate([
        observable
      ], Radio.prototype, "name", void 0);
      __decorate([
        observable
      ], Radio.prototype, "defaultSlottedNodes", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/radio/index.js
  var init_radio2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/radio/index.js"() {
      init_radio_template();
      init_radio();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/horizontal-scroll/horizontal-scroll.js
  var HorizontalScroll;
  var init_horizontal_scroll = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/horizontal-scroll/horizontal-scroll.js"() {
      init_tslib_es6();
      init_esm();
      init_foundation_element();
      HorizontalScroll = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.framesPerSecond = 60;
          this.updatingItems = false;
          this.speed = 600;
          this.easing = "ease-in-out";
          this.flippersHiddenFromAT = false;
          this.scrolling = false;
          this.resizeDetector = null;
        }
        /**
         * The calculated duration for a frame.
         *
         * @internal
         */
        get frameTime() {
          return 1e3 / this.framesPerSecond;
        }
        /**
         * Firing scrollstart and scrollend events
         * @internal
         */
        scrollingChanged(prev, next) {
          if (this.scrollContainer) {
            const event = this.scrolling == true ? "scrollstart" : "scrollend";
            this.$emit(event, this.scrollContainer.scrollLeft);
          }
        }
        /**
         * In RTL mode
         * @internal
         */
        get isRtl() {
          return this.scrollItems.length > 1 && this.scrollItems[0].offsetLeft > this.scrollItems[1].offsetLeft;
        }
        connectedCallback() {
          super.connectedCallback();
          this.initializeResizeDetector();
        }
        disconnectedCallback() {
          this.disconnectResizeDetector();
          super.disconnectedCallback();
        }
        /**
         * Updates scroll stops and flippers when scroll items change
         * @param previous - current scroll items
         * @param next - new updated scroll items
         * @public
         */
        scrollItemsChanged(previous, next) {
          if (next && !this.updatingItems) {
            DOM.queueUpdate(() => this.setStops());
          }
        }
        /**
         * destroys the instance's resize observer
         * @internal
         */
        disconnectResizeDetector() {
          if (this.resizeDetector) {
            this.resizeDetector.disconnect();
            this.resizeDetector = null;
          }
        }
        /**
         * initializes the instance's resize observer
         * @internal
         */
        initializeResizeDetector() {
          this.disconnectResizeDetector();
          this.resizeDetector = new window.ResizeObserver(this.resized.bind(this));
          this.resizeDetector.observe(this);
        }
        /**
         * Looks for slots and uses child nodes instead
         * @internal
         */
        updateScrollStops() {
          this.updatingItems = true;
          const updatedItems = this.scrollItems.reduce((scrollItems, scrollItem) => {
            if (scrollItem instanceof HTMLSlotElement) {
              return scrollItems.concat(scrollItem.assignedElements());
            }
            scrollItems.push(scrollItem);
            return scrollItems;
          }, []);
          this.scrollItems = updatedItems;
          this.updatingItems = false;
        }
        /**
         * Finds all of the scroll stops between elements
         * @internal
         */
        setStops() {
          this.updateScrollStops();
          const { scrollContainer: container } = this;
          const { scrollLeft } = container;
          const { width: containerWidth, left: containerLeft } = container.getBoundingClientRect();
          this.width = containerWidth;
          let lastStop = 0;
          let stops = this.scrollItems.map((item, index) => {
            const { left, width } = item.getBoundingClientRect();
            const leftPosition = Math.round(left + scrollLeft - containerLeft);
            const right = Math.round(leftPosition + width);
            if (this.isRtl) {
              return -right;
            }
            lastStop = right;
            return index === 0 ? 0 : leftPosition;
          }).concat(lastStop);
          stops = this.fixScrollMisalign(stops);
          stops.sort((a, b) => Math.abs(a) - Math.abs(b));
          this.scrollStops = stops;
          this.setFlippers();
        }
        /**
         * Checks to see if the stops are returning values
         *  otherwise it will try to reinitialize them
         *
         * @returns boolean indicating that current scrollStops are valid non-zero values
         * @internal
         */
        validateStops(reinit = true) {
          const hasStops = () => !!this.scrollStops.find((stop) => stop > 0);
          if (!hasStops() && reinit) {
            this.setStops();
          }
          return hasStops();
        }
        /**
         *
         */
        fixScrollMisalign(stops) {
          if (this.isRtl && stops.some((stop) => stop > 0)) {
            stops.sort((a, b) => b - a);
            const offset = stops[0];
            stops = stops.map((stop) => stop - offset);
          }
          return stops;
        }
        /**
         * Sets the controls view if enabled
         * @internal
         */
        setFlippers() {
          var _a, _b;
          const position = this.scrollContainer.scrollLeft;
          (_a = this.previousFlipperContainer) === null || _a === void 0 ? void 0 : _a.classList.toggle("disabled", position === 0);
          if (this.scrollStops) {
            const lastStop = Math.abs(this.scrollStops[this.scrollStops.length - 1]);
            (_b = this.nextFlipperContainer) === null || _b === void 0 ? void 0 : _b.classList.toggle("disabled", this.validateStops(false) && Math.abs(position) + this.width >= lastStop);
          }
        }
        /**
         * Function that can scroll an item into view.
         * @param item - An item index, a scroll item or a child of one of the scroll items
         * @param padding - Padding of the viewport where the active item shouldn't be
         * @param rightPadding - Optional right padding. Uses the padding if not defined
         *
         * @public
         */
        scrollInView(item, padding = 0, rightPadding) {
          var _a;
          if (typeof item !== "number" && item) {
            item = this.scrollItems.findIndex((scrollItem) => scrollItem === item || scrollItem.contains(item));
          }
          if (item !== void 0) {
            rightPadding = rightPadding !== null && rightPadding !== void 0 ? rightPadding : padding;
            const { scrollContainer: container, scrollStops, scrollItems: items } = this;
            const { scrollLeft } = this.scrollContainer;
            const { width: containerWidth } = container.getBoundingClientRect();
            const itemStart = scrollStops[item];
            const { width } = items[item].getBoundingClientRect();
            const itemEnd = itemStart + width;
            const isBefore = scrollLeft + padding > itemStart;
            if (isBefore || scrollLeft + containerWidth - rightPadding < itemEnd) {
              const stops = [...scrollStops].sort((a, b) => isBefore ? b - a : a - b);
              const scrollTo = (_a = stops.find((position) => isBefore ? position + padding < itemStart : position + containerWidth - (rightPadding !== null && rightPadding !== void 0 ? rightPadding : 0) > itemEnd)) !== null && _a !== void 0 ? _a : 0;
              this.scrollToPosition(scrollTo);
            }
          }
        }
        /**
         * Lets the user arrow left and right through the horizontal scroll
         * @param e - Keyboard event
         * @public
         */
        keyupHandler(e) {
          const key = e.key;
          switch (key) {
            case "ArrowLeft":
              this.scrollToPrevious();
              break;
            case "ArrowRight":
              this.scrollToNext();
              break;
          }
        }
        /**
         * Scrolls items to the left
         * @public
         */
        scrollToPrevious() {
          this.validateStops();
          const scrollPosition = this.scrollContainer.scrollLeft;
          const current = this.scrollStops.findIndex((stop, index) => stop >= scrollPosition && (this.isRtl || index === this.scrollStops.length - 1 || this.scrollStops[index + 1] > scrollPosition));
          const right = Math.abs(this.scrollStops[current + 1]);
          let nextIndex = this.scrollStops.findIndex((stop) => Math.abs(stop) + this.width > right);
          if (nextIndex >= current || nextIndex === -1) {
            nextIndex = current > 0 ? current - 1 : 0;
          }
          this.scrollToPosition(this.scrollStops[nextIndex], scrollPosition);
        }
        /**
         * Scrolls items to the right
         * @public
         */
        scrollToNext() {
          this.validateStops();
          const scrollPosition = this.scrollContainer.scrollLeft;
          const current = this.scrollStops.findIndex((stop) => Math.abs(stop) >= Math.abs(scrollPosition));
          const outOfView = this.scrollStops.findIndex((stop) => Math.abs(scrollPosition) + this.width <= Math.abs(stop));
          let nextIndex = current;
          if (outOfView > current + 2) {
            nextIndex = outOfView - 2;
          } else if (current < this.scrollStops.length - 2) {
            nextIndex = current + 1;
          }
          this.scrollToPosition(this.scrollStops[nextIndex], scrollPosition);
        }
        /**
         * Handles scrolling with easing
         * @param position - starting position
         * @param newPosition - position to scroll to
         * @public
         */
        scrollToPosition(newPosition, position = this.scrollContainer.scrollLeft) {
          var _a;
          if (this.scrolling) {
            return;
          }
          this.scrolling = true;
          const seconds = (_a = this.duration) !== null && _a !== void 0 ? _a : `${Math.abs(newPosition - position) / this.speed}s`;
          this.content.style.setProperty("transition-duration", seconds);
          const computedDuration = parseFloat(getComputedStyle(this.content).getPropertyValue("transition-duration"));
          const transitionendHandler = (e) => {
            if (e && e.target !== e.currentTarget) {
              return;
            }
            this.content.style.setProperty("transition-duration", "0s");
            this.content.style.removeProperty("transform");
            this.scrollContainer.style.setProperty("scroll-behavior", "auto");
            this.scrollContainer.scrollLeft = newPosition;
            this.setFlippers();
            this.content.removeEventListener("transitionend", transitionendHandler);
            this.scrolling = false;
          };
          if (computedDuration === 0) {
            transitionendHandler();
            return;
          }
          this.content.addEventListener("transitionend", transitionendHandler);
          const maxScrollValue = this.scrollContainer.scrollWidth - this.scrollContainer.clientWidth;
          let transitionStop = this.scrollContainer.scrollLeft - Math.min(newPosition, maxScrollValue);
          if (this.isRtl) {
            transitionStop = this.scrollContainer.scrollLeft + Math.min(Math.abs(newPosition), maxScrollValue);
          }
          this.content.style.setProperty("transition-property", "transform");
          this.content.style.setProperty("transition-timing-function", this.easing);
          this.content.style.setProperty("transform", `translateX(${transitionStop}px)`);
        }
        /**
         * Monitors resize event on the horizontal-scroll element
         * @public
         */
        resized() {
          if (this.resizeTimeout) {
            this.resizeTimeout = clearTimeout(this.resizeTimeout);
          }
          this.resizeTimeout = setTimeout(() => {
            this.width = this.scrollContainer.offsetWidth;
            this.setFlippers();
          }, this.frameTime);
        }
        /**
         * Monitors scrolled event on the content container
         * @public
         */
        scrolled() {
          if (this.scrollTimeout) {
            this.scrollTimeout = clearTimeout(this.scrollTimeout);
          }
          this.scrollTimeout = setTimeout(() => {
            this.setFlippers();
          }, this.frameTime);
        }
      };
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], HorizontalScroll.prototype, "speed", void 0);
      __decorate([
        attr
      ], HorizontalScroll.prototype, "duration", void 0);
      __decorate([
        attr
      ], HorizontalScroll.prototype, "easing", void 0);
      __decorate([
        attr({ attribute: "flippers-hidden-from-at", converter: booleanConverter })
      ], HorizontalScroll.prototype, "flippersHiddenFromAT", void 0);
      __decorate([
        observable
      ], HorizontalScroll.prototype, "scrolling", void 0);
      __decorate([
        observable
      ], HorizontalScroll.prototype, "scrollItems", void 0);
      __decorate([
        attr({ attribute: "view" })
      ], HorizontalScroll.prototype, "view", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/horizontal-scroll/horizontal-scroll.template.js
  var init_horizontal_scroll_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/horizontal-scroll/horizontal-scroll.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/horizontal-scroll/index.js
  var init_horizontal_scroll2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/horizontal-scroll/index.js"() {
      init_horizontal_scroll();
      init_horizontal_scroll_template();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/whitespace-filter.js
  function whitespaceFilter(value, index, array) {
    return value.nodeType !== Node.TEXT_NODE ? true : typeof value.nodeValue === "string" && !!value.nodeValue.trim().length;
  }
  var init_whitespace_filter = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/whitespace-filter.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/search/search.template.js
  var init_search_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/search/search.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/search/search.form-associated.js
  var _Search, FormAssociatedSearch;
  var init_search_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/search/search.form-associated.js"() {
      init_form_associated();
      init_foundation_element();
      _Search = class extends FoundationElement {
      };
      FormAssociatedSearch = class extends FormAssociated(_Search) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("input");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/search/search.js
  var Search, DelegatesARIASearch;
  var init_search = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/search/search.js"() {
      init_tslib_es6();
      init_esm();
      init_patterns();
      init_apply_mixins();
      init_search_form_associated();
      Search = class extends FormAssociatedSearch {
        readOnlyChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.readOnly = this.readOnly;
            this.validate();
          }
        }
        autofocusChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.autofocus = this.autofocus;
            this.validate();
          }
        }
        placeholderChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.placeholder = this.placeholder;
          }
        }
        listChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.setAttribute("list", this.list);
            this.validate();
          }
        }
        maxlengthChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.maxLength = this.maxlength;
            this.validate();
          }
        }
        minlengthChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.minLength = this.minlength;
            this.validate();
          }
        }
        patternChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.pattern = this.pattern;
            this.validate();
          }
        }
        sizeChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.size = this.size;
          }
        }
        spellcheckChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.spellcheck = this.spellcheck;
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.validate();
          if (this.autofocus) {
            DOM.queueUpdate(() => {
              this.focus();
            });
          }
        }
        /** {@inheritDoc (FormAssociated:interface).validate} */
        validate() {
          super.validate(this.control);
        }
        /**
         * Handles the internal control's `input` event
         * @internal
         */
        handleTextInput() {
          this.value = this.control.value;
        }
        /**
         * Handles the control's clear value event
         * @public
         */
        handleClearInput() {
          this.value = "";
          this.control.focus();
          this.handleChange();
        }
        /**
         * Change event handler for inner control.
         * @remarks
         * "Change" events are not `composable` so they will not
         * permeate the shadow DOM boundary. This fn effectively proxies
         * the change event, emitting a `change` event whenever the internal
         * control emits a `change` event
         * @internal
         */
        handleChange() {
          this.$emit("change");
        }
      };
      __decorate([
        attr({ attribute: "readonly", mode: "boolean" })
      ], Search.prototype, "readOnly", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], Search.prototype, "autofocus", void 0);
      __decorate([
        attr
      ], Search.prototype, "placeholder", void 0);
      __decorate([
        attr
      ], Search.prototype, "list", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], Search.prototype, "maxlength", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], Search.prototype, "minlength", void 0);
      __decorate([
        attr
      ], Search.prototype, "pattern", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], Search.prototype, "size", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], Search.prototype, "spellcheck", void 0);
      __decorate([
        observable
      ], Search.prototype, "defaultSlottedNodes", void 0);
      DelegatesARIASearch = class {
      };
      applyMixins(DelegatesARIASearch, ARIAGlobalStatesAndProperties);
      applyMixins(Search, StartEnd, DelegatesARIASearch);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/search/index.js
  var init_search2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/search/index.js"() {
      init_search_template();
      init_search();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/select/select.form-associated.js
  var _Select, FormAssociatedSelect;
  var init_select_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/select/select.form-associated.js"() {
      init_listbox_element();
      init_form_associated();
      _Select = class extends ListboxElement {
      };
      FormAssociatedSelect = class extends FormAssociated(_Select) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("select");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/select/select.js
  var Select, DelegatesARIASelect;
  var init_select = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/select/select.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_listbox();
      init_start_end();
      init_apply_mixins();
      init_select_form_associated();
      init_select_options();
      Select = class extends FormAssociatedSelect {
        constructor() {
          super(...arguments);
          this.open = false;
          this.forcedPosition = false;
          this.listboxId = uniqueId("listbox-");
          this.maxHeight = 0;
        }
        /**
         * Sets focus and synchronizes ARIA attributes when the open property changes.
         *
         * @param prev - the previous open value
         * @param next - the current open value
         *
         * @internal
         */
        openChanged(prev, next) {
          if (!this.collapsible) {
            return;
          }
          if (this.open) {
            this.ariaControls = this.listboxId;
            this.ariaExpanded = "true";
            this.setPositioning();
            this.focusAndScrollOptionIntoView();
            this.indexWhenOpened = this.selectedIndex;
            DOM.queueUpdate(() => this.focus());
            return;
          }
          this.ariaControls = "";
          this.ariaExpanded = "false";
        }
        /**
         * The component is collapsible when in single-selection mode with no size attribute.
         *
         * @internal
         */
        get collapsible() {
          return !(this.multiple || typeof this.size === "number");
        }
        /**
         * The value property.
         *
         * @public
         */
        get value() {
          Observable.track(this, "value");
          return this._value;
        }
        set value(next) {
          var _a, _b, _c, _d, _e, _f, _g;
          const prev = `${this._value}`;
          if ((_a = this._options) === null || _a === void 0 ? void 0 : _a.length) {
            const selectedIndex = this._options.findIndex((el) => el.value === next);
            const prevSelectedValue = (_c = (_b = this._options[this.selectedIndex]) === null || _b === void 0 ? void 0 : _b.value) !== null && _c !== void 0 ? _c : null;
            const nextSelectedValue = (_e = (_d = this._options[selectedIndex]) === null || _d === void 0 ? void 0 : _d.value) !== null && _e !== void 0 ? _e : null;
            if (selectedIndex === -1 || prevSelectedValue !== nextSelectedValue) {
              next = "";
              this.selectedIndex = selectedIndex;
            }
            next = (_g = (_f = this.firstSelectedOption) === null || _f === void 0 ? void 0 : _f.value) !== null && _g !== void 0 ? _g : next;
          }
          if (prev !== next) {
            this._value = next;
            super.valueChanged(prev, next);
            Observable.notify(this, "value");
            this.updateDisplayValue();
          }
        }
        /**
         * Sets the value and display value to match the first selected option.
         *
         * @param shouldEmit - if true, the input and change events will be emitted
         *
         * @internal
         */
        updateValue(shouldEmit) {
          var _a, _b;
          if (this.$fastController.isConnected) {
            this.value = (_b = (_a = this.firstSelectedOption) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : "";
          }
          if (shouldEmit) {
            this.$emit("input");
            this.$emit("change", this, {
              bubbles: true,
              composed: void 0
            });
          }
        }
        /**
         * Updates the proxy value when the selected index changes.
         *
         * @param prev - the previous selected index
         * @param next - the next selected index
         *
         * @internal
         */
        selectedIndexChanged(prev, next) {
          super.selectedIndexChanged(prev, next);
          this.updateValue();
        }
        positionChanged(prev, next) {
          this.positionAttribute = next;
          this.setPositioning();
        }
        /**
         * Calculate and apply listbox positioning based on available viewport space.
         *
         * @public
         */
        setPositioning() {
          const currentBox = this.getBoundingClientRect();
          const viewportHeight = window.innerHeight;
          const availableBottom = viewportHeight - currentBox.bottom;
          this.position = this.forcedPosition ? this.positionAttribute : currentBox.top > availableBottom ? SelectPosition.above : SelectPosition.below;
          this.positionAttribute = this.forcedPosition ? this.positionAttribute : this.position;
          this.maxHeight = this.position === SelectPosition.above ? ~~currentBox.top : ~~availableBottom;
        }
        /**
         * The value displayed on the button.
         *
         * @public
         */
        get displayValue() {
          var _a, _b;
          Observable.track(this, "displayValue");
          return (_b = (_a = this.firstSelectedOption) === null || _a === void 0 ? void 0 : _a.text) !== null && _b !== void 0 ? _b : "";
        }
        /**
         * Synchronize the `aria-disabled` property when the `disabled` property changes.
         *
         * @param prev - The previous disabled value
         * @param next - The next disabled value
         *
         * @internal
         */
        disabledChanged(prev, next) {
          if (super.disabledChanged) {
            super.disabledChanged(prev, next);
          }
          this.ariaDisabled = this.disabled ? "true" : "false";
        }
        /**
         * Reset the element to its first selectable option when its parent form is reset.
         *
         * @internal
         */
        formResetCallback() {
          this.setProxyOptions();
          super.setDefaultSelectedOption();
          if (this.selectedIndex === -1) {
            this.selectedIndex = 0;
          }
        }
        /**
         * Handle opening and closing the listbox when the select is clicked.
         *
         * @param e - the mouse event
         * @internal
         */
        clickHandler(e) {
          if (this.disabled) {
            return;
          }
          if (this.open) {
            const captured = e.target.closest(`option,[role=option]`);
            if (captured && captured.disabled) {
              return;
            }
          }
          super.clickHandler(e);
          this.open = this.collapsible && !this.open;
          if (!this.open && this.indexWhenOpened !== this.selectedIndex) {
            this.updateValue(true);
          }
          return true;
        }
        /**
         * Handles focus state when the element or its children lose focus.
         *
         * @param e - The focus event
         * @internal
         */
        focusoutHandler(e) {
          var _a;
          super.focusoutHandler(e);
          if (!this.open) {
            return true;
          }
          const focusTarget = e.relatedTarget;
          if (this.isSameNode(focusTarget)) {
            this.focus();
            return;
          }
          if (!((_a = this.options) === null || _a === void 0 ? void 0 : _a.includes(focusTarget))) {
            this.open = false;
            if (this.indexWhenOpened !== this.selectedIndex) {
              this.updateValue(true);
            }
          }
        }
        /**
         * Updates the value when an option's value changes.
         *
         * @param source - the source object
         * @param propertyName - the property to evaluate
         *
         * @internal
         * @override
         */
        handleChange(source, propertyName) {
          super.handleChange(source, propertyName);
          if (propertyName === "value") {
            this.updateValue();
          }
        }
        /**
         * Synchronize the form-associated proxy and updates the value property of the element.
         *
         * @param prev - the previous collection of slotted option elements
         * @param next - the next collection of slotted option elements
         *
         * @internal
         */
        slottedOptionsChanged(prev, next) {
          this.options.forEach((o) => {
            const notifier = Observable.getNotifier(o);
            notifier.unsubscribe(this, "value");
          });
          super.slottedOptionsChanged(prev, next);
          this.options.forEach((o) => {
            const notifier = Observable.getNotifier(o);
            notifier.subscribe(this, "value");
          });
          this.setProxyOptions();
          this.updateValue();
        }
        /**
         * Prevents focus when size is set and a scrollbar is clicked.
         *
         * @param e - the mouse event object
         *
         * @override
         * @internal
         */
        mousedownHandler(e) {
          var _a;
          if (e.offsetX >= 0 && e.offsetX <= ((_a = this.listbox) === null || _a === void 0 ? void 0 : _a.scrollWidth)) {
            return super.mousedownHandler(e);
          }
          return this.collapsible;
        }
        /**
         * Sets the multiple property on the proxy element.
         *
         * @param prev - the previous multiple value
         * @param next - the current multiple value
         */
        multipleChanged(prev, next) {
          super.multipleChanged(prev, next);
          if (this.proxy) {
            this.proxy.multiple = next;
          }
        }
        /**
         * Updates the selectedness of each option when the list of selected options changes.
         *
         * @param prev - the previous list of selected options
         * @param next - the current list of selected options
         *
         * @override
         * @internal
         */
        selectedOptionsChanged(prev, next) {
          var _a;
          super.selectedOptionsChanged(prev, next);
          (_a = this.options) === null || _a === void 0 ? void 0 : _a.forEach((o, i) => {
            var _a2;
            const proxyOption = (_a2 = this.proxy) === null || _a2 === void 0 ? void 0 : _a2.options.item(i);
            if (proxyOption) {
              proxyOption.selected = o.selected;
            }
          });
        }
        /**
         * Sets the selected index to match the first option with the selected attribute, or
         * the first selectable option.
         *
         * @override
         * @internal
         */
        setDefaultSelectedOption() {
          var _a;
          const options = (_a = this.options) !== null && _a !== void 0 ? _a : Array.from(this.children).filter(Listbox.slottedOptionFilter);
          const selectedIndex = options === null || options === void 0 ? void 0 : options.findIndex((el) => el.hasAttribute("selected") || el.selected || el.value === this.value);
          if (selectedIndex !== -1) {
            this.selectedIndex = selectedIndex;
            return;
          }
          this.selectedIndex = 0;
        }
        /**
         * Resets and fills the proxy to match the component's options.
         *
         * @internal
         */
        setProxyOptions() {
          if (this.proxy instanceof HTMLSelectElement && this.options) {
            this.proxy.options.length = 0;
            this.options.forEach((option) => {
              const proxyOption = option.proxy || (option instanceof HTMLOptionElement ? option.cloneNode() : null);
              if (proxyOption) {
                this.proxy.options.add(proxyOption);
              }
            });
          }
        }
        /**
         * Handle keyboard interaction for the select.
         *
         * @param e - the keyboard event
         * @internal
         */
        keydownHandler(e) {
          super.keydownHandler(e);
          const key = e.key || e.key.charCodeAt(0);
          switch (key) {
            case keySpace: {
              e.preventDefault();
              if (this.collapsible && this.typeAheadExpired) {
                this.open = !this.open;
              }
              break;
            }
            case keyHome:
            case keyEnd: {
              e.preventDefault();
              break;
            }
            case keyEnter: {
              e.preventDefault();
              this.open = !this.open;
              break;
            }
            case keyEscape: {
              if (this.collapsible && this.open) {
                e.preventDefault();
                this.open = false;
              }
              break;
            }
            case keyTab: {
              if (this.collapsible && this.open) {
                e.preventDefault();
                this.open = false;
              }
              return true;
            }
          }
          if (!this.open && this.indexWhenOpened !== this.selectedIndex) {
            this.updateValue(true);
            this.indexWhenOpened = this.selectedIndex;
          }
          return !(key === keyArrowDown || key === keyArrowUp);
        }
        connectedCallback() {
          super.connectedCallback();
          this.forcedPosition = !!this.positionAttribute;
          this.addEventListener("contentchange", this.updateDisplayValue);
        }
        disconnectedCallback() {
          this.removeEventListener("contentchange", this.updateDisplayValue);
          super.disconnectedCallback();
        }
        /**
         * Updates the proxy's size property when the size attribute changes.
         *
         * @param prev - the previous size
         * @param next - the current size
         *
         * @override
         * @internal
         */
        sizeChanged(prev, next) {
          super.sizeChanged(prev, next);
          if (this.proxy) {
            this.proxy.size = next;
          }
        }
        /**
         *
         * @internal
         */
        updateDisplayValue() {
          if (this.collapsible) {
            Observable.notify(this, "displayValue");
          }
        }
      };
      __decorate([
        attr({ attribute: "open", mode: "boolean" })
      ], Select.prototype, "open", void 0);
      __decorate([
        volatile
      ], Select.prototype, "collapsible", null);
      __decorate([
        observable
      ], Select.prototype, "control", void 0);
      __decorate([
        attr({ attribute: "position" })
      ], Select.prototype, "positionAttribute", void 0);
      __decorate([
        observable
      ], Select.prototype, "position", void 0);
      __decorate([
        observable
      ], Select.prototype, "maxHeight", void 0);
      DelegatesARIASelect = class {
      };
      __decorate([
        observable
      ], DelegatesARIASelect.prototype, "ariaControls", void 0);
      applyMixins(DelegatesARIASelect, DelegatesARIAListbox);
      applyMixins(Select, StartEnd, DelegatesARIASelect);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/select/select.template.js
  var selectTemplate;
  var init_select_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/select/select.template.js"() {
      init_esm();
      init_listbox();
      init_start_end();
      selectTemplate = (context, definition) => html`
    <template
        class="${(x) => [
        x.collapsible && "collapsible",
        x.collapsible && x.open && "open",
        x.disabled && "disabled",
        x.collapsible && x.position
      ].filter(Boolean).join(" ")}"
        aria-activedescendant="${(x) => x.ariaActiveDescendant}"
        aria-controls="${(x) => x.ariaControls}"
        aria-disabled="${(x) => x.ariaDisabled}"
        aria-expanded="${(x) => x.ariaExpanded}"
        aria-haspopup="${(x) => x.collapsible ? "listbox" : null}"
        aria-multiselectable="${(x) => x.ariaMultiSelectable}"
        ?open="${(x) => x.open}"
        role="combobox"
        tabindex="${(x) => !x.disabled ? "0" : null}"
        @click="${(x, c) => x.clickHandler(c.event)}"
        @focusin="${(x, c) => x.focusinHandler(c.event)}"
        @focusout="${(x, c) => x.focusoutHandler(c.event)}"
        @keydown="${(x, c) => x.keydownHandler(c.event)}"
        @mousedown="${(x, c) => x.mousedownHandler(c.event)}"
    >
        ${when((x) => x.collapsible, html`
                <div
                    class="control"
                    part="control"
                    ?disabled="${(x) => x.disabled}"
                    ${ref("control")}
                >
                    ${startSlotTemplate(context, definition)}
                    <slot name="button-container">
                        <div class="selected-value" part="selected-value">
                            <slot name="selected-value">${(x) => x.displayValue}</slot>
                        </div>
                        <div aria-hidden="true" class="indicator" part="indicator">
                            <slot name="indicator">
                                ${definition.indicator || ""}
                            </slot>
                        </div>
                    </slot>
                    ${endSlotTemplate(context, definition)}
                </div>
            `)}
        <div
            class="listbox"
            id="${(x) => x.listboxId}"
            part="listbox"
            role="listbox"
            ?disabled="${(x) => x.disabled}"
            ?hidden="${(x) => x.collapsible ? !x.open : false}"
            ${ref("listbox")}
        >
            <slot
                ${slotted({
        filter: Listbox.slottedOptionFilter,
        flatten: true,
        property: "slottedOptions"
      })}
            ></slot>
        </div>
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/select/index.js
  var init_select2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/select/index.js"() {
      init_select();
      init_select_options();
      init_select_template();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/skeleton/skeleton.template.js
  var init_skeleton_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/skeleton/skeleton.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/skeleton/skeleton.js
  var Skeleton;
  var init_skeleton = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/skeleton/skeleton.js"() {
      init_tslib_es6();
      init_esm();
      init_foundation_element();
      Skeleton = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.shape = "rect";
        }
      };
      __decorate([
        attr
      ], Skeleton.prototype, "fill", void 0);
      __decorate([
        attr
      ], Skeleton.prototype, "shape", void 0);
      __decorate([
        attr
      ], Skeleton.prototype, "pattern", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], Skeleton.prototype, "shimmer", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/skeleton/index.js
  var init_skeleton2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/skeleton/index.js"() {
      init_skeleton_template();
      init_skeleton();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/slider-label/slider-label.template.js
  var init_slider_label_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/slider-label/slider-label.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/slider/slider-utilities.js
  function convertPixelToPercent(pixelPos, minPosition, maxPosition, direction) {
    let pct = limit(0, 1, (pixelPos - minPosition) / (maxPosition - minPosition));
    if (direction === Direction.rtl) {
      pct = 1 - pct;
    }
    return pct;
  }
  var init_slider_utilities = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/slider/slider-utilities.js"() {
      init_dist2();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/slider-label/slider-label.js
  var defaultConfig, SliderLabel;
  var init_slider_label = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/slider-label/slider-label.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_slider_utilities();
      init_foundation_element();
      defaultConfig = {
        min: 0,
        max: 0,
        direction: Direction.ltr,
        orientation: Orientation.horizontal,
        disabled: false
      };
      SliderLabel = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.hideMark = false;
          this.sliderDirection = Direction.ltr;
          this.getSliderConfiguration = () => {
            if (!this.isSliderConfig(this.parentNode)) {
              this.sliderDirection = defaultConfig.direction || Direction.ltr;
              this.sliderOrientation = defaultConfig.orientation || Orientation.horizontal;
              this.sliderMaxPosition = defaultConfig.max;
              this.sliderMinPosition = defaultConfig.min;
            } else {
              const parentSlider = this.parentNode;
              const { min, max, direction, orientation, disabled } = parentSlider;
              if (disabled !== void 0) {
                this.disabled = disabled;
              }
              this.sliderDirection = direction || Direction.ltr;
              this.sliderOrientation = orientation || Orientation.horizontal;
              this.sliderMaxPosition = max;
              this.sliderMinPosition = min;
            }
          };
          this.positionAsStyle = () => {
            const direction = this.sliderDirection ? this.sliderDirection : Direction.ltr;
            const pct = convertPixelToPercent(Number(this.position), Number(this.sliderMinPosition), Number(this.sliderMaxPosition));
            let rightNum = Math.round((1 - pct) * 100);
            let leftNum = Math.round(pct * 100);
            if (Number.isNaN(leftNum) && Number.isNaN(rightNum)) {
              rightNum = 50;
              leftNum = 50;
            }
            if (this.sliderOrientation === Orientation.horizontal) {
              return direction === Direction.rtl ? `right: ${leftNum}%; left: ${rightNum}%;` : `left: ${leftNum}%; right: ${rightNum}%;`;
            } else {
              return `top: ${leftNum}%; bottom: ${rightNum}%;`;
            }
          };
        }
        positionChanged() {
          this.positionStyle = this.positionAsStyle();
        }
        /**
         * @internal
         */
        sliderOrientationChanged() {
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.getSliderConfiguration();
          this.positionStyle = this.positionAsStyle();
          this.notifier = Observable.getNotifier(this.parentNode);
          this.notifier.subscribe(this, "orientation");
          this.notifier.subscribe(this, "direction");
          this.notifier.subscribe(this, "max");
          this.notifier.subscribe(this, "min");
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          super.disconnectedCallback();
          this.notifier.unsubscribe(this, "orientation");
          this.notifier.unsubscribe(this, "direction");
          this.notifier.unsubscribe(this, "max");
          this.notifier.unsubscribe(this, "min");
        }
        /**
         * @internal
         */
        handleChange(source, propertyName) {
          switch (propertyName) {
            case "direction":
              this.sliderDirection = source.direction;
              break;
            case "orientation":
              this.sliderOrientation = source.orientation;
              break;
            case "max":
              this.sliderMaxPosition = source.max;
              break;
            case "min":
              this.sliderMinPosition = source.min;
              break;
            default:
              break;
          }
          this.positionStyle = this.positionAsStyle();
        }
        isSliderConfig(node) {
          return node.max !== void 0 && node.min !== void 0;
        }
      };
      __decorate([
        observable
      ], SliderLabel.prototype, "positionStyle", void 0);
      __decorate([
        attr
      ], SliderLabel.prototype, "position", void 0);
      __decorate([
        attr({ attribute: "hide-mark", mode: "boolean" })
      ], SliderLabel.prototype, "hideMark", void 0);
      __decorate([
        attr({ attribute: "disabled", mode: "boolean" })
      ], SliderLabel.prototype, "disabled", void 0);
      __decorate([
        observable
      ], SliderLabel.prototype, "sliderOrientation", void 0);
      __decorate([
        observable
      ], SliderLabel.prototype, "sliderMinPosition", void 0);
      __decorate([
        observable
      ], SliderLabel.prototype, "sliderMaxPosition", void 0);
      __decorate([
        observable
      ], SliderLabel.prototype, "sliderDirection", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/slider-label/index.js
  var init_slider_label2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/slider-label/index.js"() {
      init_slider_label_template();
      init_slider_label();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/slider/slider.template.js
  var init_slider_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/slider/slider.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/slider/slider.form-associated.js
  var _Slider, FormAssociatedSlider;
  var init_slider_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/slider/slider.form-associated.js"() {
      init_form_associated();
      init_foundation_element();
      _Slider = class extends FoundationElement {
      };
      FormAssociatedSlider = class extends FormAssociated(_Slider) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("input");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/slider/slider.js
  var SliderMode, Slider;
  var init_slider = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/slider/slider.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_direction();
      init_slider_utilities();
      init_slider_form_associated();
      SliderMode = {
        singleValue: "single-value"
      };
      Slider = class extends FormAssociatedSlider {
        constructor() {
          super(...arguments);
          this.direction = Direction.ltr;
          this.isDragging = false;
          this.trackWidth = 0;
          this.trackMinWidth = 0;
          this.trackHeight = 0;
          this.trackLeft = 0;
          this.trackMinHeight = 0;
          this.valueTextFormatter = () => null;
          this.min = 0;
          this.max = 10;
          this.step = 1;
          this.orientation = Orientation.horizontal;
          this.mode = SliderMode.singleValue;
          this.keypressHandler = (e) => {
            if (this.readOnly) {
              return;
            }
            if (e.key === keyHome) {
              e.preventDefault();
              this.value = `${this.min}`;
            } else if (e.key === keyEnd) {
              e.preventDefault();
              this.value = `${this.max}`;
            } else if (!e.shiftKey) {
              switch (e.key) {
                case keyArrowRight:
                case keyArrowUp:
                  e.preventDefault();
                  this.increment();
                  break;
                case keyArrowLeft:
                case keyArrowDown:
                  e.preventDefault();
                  this.decrement();
                  break;
              }
            }
          };
          this.setupTrackConstraints = () => {
            const clientRect = this.track.getBoundingClientRect();
            this.trackWidth = this.track.clientWidth;
            this.trackMinWidth = this.track.clientLeft;
            this.trackHeight = clientRect.bottom;
            this.trackMinHeight = clientRect.top;
            this.trackLeft = this.getBoundingClientRect().left;
            if (this.trackWidth === 0) {
              this.trackWidth = 1;
            }
          };
          this.setupListeners = (remove = false) => {
            const eventAction = `${remove ? "remove" : "add"}EventListener`;
            this[eventAction]("keydown", this.keypressHandler);
            this[eventAction]("mousedown", this.handleMouseDown);
            this.thumb[eventAction]("mousedown", this.handleThumbMouseDown, {
              passive: true
            });
            this.thumb[eventAction]("touchstart", this.handleThumbMouseDown, {
              passive: true
            });
            if (remove) {
              this.handleMouseDown(null);
              this.handleThumbMouseDown(null);
            }
          };
          this.initialValue = "";
          this.handleThumbMouseDown = (event) => {
            if (event) {
              if (this.readOnly || this.disabled || event.defaultPrevented) {
                return;
              }
              event.target.focus();
            }
            const eventAction = `${event !== null ? "add" : "remove"}EventListener`;
            window[eventAction]("mouseup", this.handleWindowMouseUp);
            window[eventAction]("mousemove", this.handleMouseMove, { passive: true });
            window[eventAction]("touchmove", this.handleMouseMove, { passive: true });
            window[eventAction]("touchend", this.handleWindowMouseUp);
            this.isDragging = event !== null;
          };
          this.handleMouseMove = (e) => {
            if (this.readOnly || this.disabled || e.defaultPrevented) {
              return;
            }
            const sourceEvent = window.TouchEvent && e instanceof TouchEvent ? e.touches[0] : e;
            const eventValue = this.orientation === Orientation.horizontal ? sourceEvent.pageX - document.documentElement.scrollLeft - this.trackLeft : sourceEvent.pageY - document.documentElement.scrollTop;
            this.value = `${this.calculateNewValue(eventValue)}`;
          };
          this.calculateNewValue = (rawValue) => {
            const newPosition = convertPixelToPercent(rawValue, this.orientation === Orientation.horizontal ? this.trackMinWidth : this.trackMinHeight, this.orientation === Orientation.horizontal ? this.trackWidth : this.trackHeight, this.direction);
            const newValue = (this.max - this.min) * newPosition + this.min;
            return this.convertToConstrainedValue(newValue);
          };
          this.handleWindowMouseUp = (event) => {
            this.stopDragging();
          };
          this.stopDragging = () => {
            this.isDragging = false;
            this.handleMouseDown(null);
            this.handleThumbMouseDown(null);
          };
          this.handleMouseDown = (e) => {
            const eventAction = `${e !== null ? "add" : "remove"}EventListener`;
            if (e === null || !this.disabled && !this.readOnly) {
              window[eventAction]("mouseup", this.handleWindowMouseUp);
              window.document[eventAction]("mouseleave", this.handleWindowMouseUp);
              window[eventAction]("mousemove", this.handleMouseMove);
              if (e) {
                e.preventDefault();
                this.setupTrackConstraints();
                e.target.focus();
                const controlValue = this.orientation === Orientation.horizontal ? e.pageX - document.documentElement.scrollLeft - this.trackLeft : e.pageY - document.documentElement.scrollTop;
                this.value = `${this.calculateNewValue(controlValue)}`;
              }
            }
          };
          this.convertToConstrainedValue = (value) => {
            if (isNaN(value)) {
              value = this.min;
            }
            let constrainedValue = value - this.min;
            const roundedConstrainedValue = Math.round(constrainedValue / this.step);
            const remainderValue = constrainedValue - roundedConstrainedValue * (this.stepMultiplier * this.step) / this.stepMultiplier;
            constrainedValue = remainderValue >= Number(this.step) / 2 ? constrainedValue - remainderValue + Number(this.step) : constrainedValue - remainderValue;
            return constrainedValue + this.min;
          };
        }
        readOnlyChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.readOnly = this.readOnly;
          }
        }
        /**
         * The value property, typed as a number.
         *
         * @public
         */
        get valueAsNumber() {
          return parseFloat(super.value);
        }
        set valueAsNumber(next) {
          this.value = next.toString();
        }
        /**
         * @internal
         */
        valueChanged(previous, next) {
          super.valueChanged(previous, next);
          if (this.$fastController.isConnected) {
            this.setThumbPositionForOrientation(this.direction);
          }
          this.$emit("change");
        }
        minChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.min = `${this.min}`;
          }
          this.validate();
        }
        maxChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.max = `${this.max}`;
          }
          this.validate();
        }
        stepChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.step = `${this.step}`;
          }
          this.updateStepMultiplier();
          this.validate();
        }
        orientationChanged() {
          if (this.$fastController.isConnected) {
            this.setThumbPositionForOrientation(this.direction);
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.proxy.setAttribute("type", "range");
          this.direction = getDirection(this);
          this.updateStepMultiplier();
          this.setupTrackConstraints();
          this.setupListeners();
          this.setupDefaultValue();
          this.setThumbPositionForOrientation(this.direction);
        }
        /**
         * @internal
         */
        disconnectedCallback() {
          this.setupListeners(true);
        }
        /**
         * Increment the value by the step
         *
         * @public
         */
        increment() {
          const newVal = this.direction !== Direction.rtl && this.orientation !== Orientation.vertical ? Number(this.value) + Number(this.step) : Number(this.value) - Number(this.step);
          const incrementedVal = this.convertToConstrainedValue(newVal);
          const incrementedValString = incrementedVal < Number(this.max) ? `${incrementedVal}` : `${this.max}`;
          this.value = incrementedValString;
        }
        /**
         * Decrement the value by the step
         *
         * @public
         */
        decrement() {
          const newVal = this.direction !== Direction.rtl && this.orientation !== Orientation.vertical ? Number(this.value) - Number(this.step) : Number(this.value) + Number(this.step);
          const decrementedVal = this.convertToConstrainedValue(newVal);
          const decrementedValString = decrementedVal > Number(this.min) ? `${decrementedVal}` : `${this.min}`;
          this.value = decrementedValString;
        }
        /**
         * Places the thumb based on the current value
         *
         * @public
         * @param direction - writing mode
         */
        setThumbPositionForOrientation(direction) {
          const newPct = convertPixelToPercent(Number(this.value), Number(this.min), Number(this.max), direction);
          const percentage = (1 - newPct) * 100;
          if (this.orientation === Orientation.horizontal) {
            this.position = this.isDragging ? `right: ${percentage}%; transition: none;` : `right: ${percentage}%; transition: all 0.2s ease;`;
          } else {
            this.position = this.isDragging ? `bottom: ${percentage}%; transition: none;` : `bottom: ${percentage}%; transition: all 0.2s ease;`;
          }
        }
        /**
         * Update the step multiplier used to ensure rounding errors from steps that
         * are not whole numbers
         */
        updateStepMultiplier() {
          const stepString = this.step + "";
          const decimalPlacesOfStep = !!(this.step % 1) ? stepString.length - stepString.indexOf(".") - 1 : 0;
          this.stepMultiplier = Math.pow(10, decimalPlacesOfStep);
        }
        get midpoint() {
          return `${this.convertToConstrainedValue((this.max + this.min) / 2)}`;
        }
        setupDefaultValue() {
          if (typeof this.value === "string") {
            if (this.value.length === 0) {
              this.initialValue = this.midpoint;
            } else {
              const value = parseFloat(this.value);
              if (!Number.isNaN(value) && (value < this.min || value > this.max)) {
                this.value = this.midpoint;
              }
            }
          }
        }
      };
      __decorate([
        attr({ attribute: "readonly", mode: "boolean" })
      ], Slider.prototype, "readOnly", void 0);
      __decorate([
        observable
      ], Slider.prototype, "direction", void 0);
      __decorate([
        observable
      ], Slider.prototype, "isDragging", void 0);
      __decorate([
        observable
      ], Slider.prototype, "position", void 0);
      __decorate([
        observable
      ], Slider.prototype, "trackWidth", void 0);
      __decorate([
        observable
      ], Slider.prototype, "trackMinWidth", void 0);
      __decorate([
        observable
      ], Slider.prototype, "trackHeight", void 0);
      __decorate([
        observable
      ], Slider.prototype, "trackLeft", void 0);
      __decorate([
        observable
      ], Slider.prototype, "trackMinHeight", void 0);
      __decorate([
        observable
      ], Slider.prototype, "valueTextFormatter", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], Slider.prototype, "min", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], Slider.prototype, "max", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], Slider.prototype, "step", void 0);
      __decorate([
        attr
      ], Slider.prototype, "orientation", void 0);
      __decorate([
        attr
      ], Slider.prototype, "mode", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/slider/index.js
  var init_slider2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/slider/index.js"() {
      init_slider_template();
      init_slider();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/switch/switch.template.js
  var init_switch_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/switch/switch.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/switch/switch.form-associated.js
  var _Switch, FormAssociatedSwitch;
  var init_switch_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/switch/switch.form-associated.js"() {
      init_form_associated();
      init_foundation_element();
      _Switch = class extends FoundationElement {
      };
      FormAssociatedSwitch = class extends CheckableFormAssociated(_Switch) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("input");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/switch/switch.js
  var Switch;
  var init_switch = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/switch/switch.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_switch_form_associated();
      Switch = class extends FormAssociatedSwitch {
        constructor() {
          super();
          this.initialValue = "on";
          this.keypressHandler = (e) => {
            if (this.readOnly) {
              return;
            }
            switch (e.key) {
              case keyEnter:
              case keySpace:
                this.checked = !this.checked;
                break;
            }
          };
          this.clickHandler = (e) => {
            if (!this.disabled && !this.readOnly) {
              this.checked = !this.checked;
            }
          };
          this.proxy.setAttribute("type", "checkbox");
        }
        readOnlyChanged() {
          if (this.proxy instanceof HTMLInputElement) {
            this.proxy.readOnly = this.readOnly;
          }
          this.readOnly ? this.classList.add("readonly") : this.classList.remove("readonly");
        }
        /**
         * @internal
         */
        checkedChanged(prev, next) {
          super.checkedChanged(prev, next);
          this.checked ? this.classList.add("checked") : this.classList.remove("checked");
        }
      };
      __decorate([
        attr({ attribute: "readonly", mode: "boolean" })
      ], Switch.prototype, "readOnly", void 0);
      __decorate([
        observable
      ], Switch.prototype, "defaultSlottedNodes", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/switch/index.js
  var init_switch2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/switch/index.js"() {
      init_switch_template();
      init_switch();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tab-panel/tab-panel.template.js
  var tabPanelTemplate;
  var init_tab_panel_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tab-panel/tab-panel.template.js"() {
      init_esm();
      tabPanelTemplate = (context, definition) => html`
    <template slot="tabpanel" role="tabpanel">
        <slot></slot>
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tab-panel/tab-panel.js
  var TabPanel;
  var init_tab_panel = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tab-panel/tab-panel.js"() {
      init_foundation_element();
      TabPanel = class extends FoundationElement {
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tab-panel/index.js
  var init_tab_panel2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tab-panel/index.js"() {
      init_tab_panel_template();
      init_tab_panel();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tab/tab.template.js
  var tabTemplate;
  var init_tab_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tab/tab.template.js"() {
      init_esm();
      tabTemplate = (context, definition) => html`
    <template slot="tab" role="tab" aria-disabled="${(x) => x.disabled}">
        <slot></slot>
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tab/tab.js
  var Tab;
  var init_tab = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tab/tab.js"() {
      init_tslib_es6();
      init_esm();
      init_foundation_element();
      Tab = class extends FoundationElement {
      };
      __decorate([
        attr({ mode: "boolean" })
      ], Tab.prototype, "disabled", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tab/index.js
  var init_tab2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tab/index.js"() {
      init_tab_template();
      init_tab();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tabs/tabs.template.js
  var tabsTemplate;
  var init_tabs_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tabs/tabs.template.js"() {
      init_esm();
      init_start_end();
      tabsTemplate = (context, definition) => html`
    <template class="${(x) => x.orientation}">
        ${startSlotTemplate(context, definition)}
        <div class="tablist" part="tablist" role="tablist">
            <slot class="tab" name="tab" part="tab" ${slotted("tabs")}></slot>

            ${when((x) => x.showActiveIndicator, html`
                    <div
                        ${ref("activeIndicatorRef")}
                        class="activeIndicator"
                        part="activeIndicator"
                    ></div>
                `)}
        </div>
        ${endSlotTemplate(context, definition)}
        <div class="tabpanel" part="tabpanel">
            <slot name="tabpanel" ${slotted("tabpanels")}></slot>
        </div>
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tabs/tabs.js
  var TabsOrientation, Tabs;
  var init_tabs = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tabs/tabs.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_start_end();
      init_apply_mixins();
      init_foundation_element();
      TabsOrientation = {
        vertical: "vertical",
        horizontal: "horizontal"
      };
      Tabs = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.orientation = TabsOrientation.horizontal;
          this.activeindicator = true;
          this.showActiveIndicator = true;
          this.prevActiveTabIndex = 0;
          this.activeTabIndex = 0;
          this.ticking = false;
          this.change = () => {
            this.$emit("change", this.activetab);
          };
          this.isDisabledElement = (el) => {
            return el.getAttribute("aria-disabled") === "true";
          };
          this.isHiddenElement = (el) => {
            return el.hasAttribute("hidden");
          };
          this.isFocusableElement = (el) => {
            return !this.isDisabledElement(el) && !this.isHiddenElement(el);
          };
          this.setTabs = () => {
            const gridHorizontalProperty = "gridColumn";
            const gridVerticalProperty = "gridRow";
            const gridProperty = this.isHorizontal() ? gridHorizontalProperty : gridVerticalProperty;
            this.activeTabIndex = this.getActiveIndex();
            this.showActiveIndicator = false;
            this.tabs.forEach((tab, index) => {
              if (tab.slot === "tab") {
                const isActiveTab = this.activeTabIndex === index && this.isFocusableElement(tab);
                if (this.activeindicator && this.isFocusableElement(tab)) {
                  this.showActiveIndicator = true;
                }
                const tabId = this.tabIds[index];
                const tabpanelId = this.tabpanelIds[index];
                tab.setAttribute("id", tabId);
                tab.setAttribute("aria-selected", isActiveTab ? "true" : "false");
                tab.setAttribute("aria-controls", tabpanelId);
                tab.addEventListener("click", this.handleTabClick);
                tab.addEventListener("keydown", this.handleTabKeyDown);
                tab.setAttribute("tabindex", isActiveTab ? "0" : "-1");
                if (isActiveTab) {
                  this.activetab = tab;
                  this.activeid = tabId;
                }
              }
              tab.style[gridHorizontalProperty] = "";
              tab.style[gridVerticalProperty] = "";
              tab.style[gridProperty] = `${index + 1}`;
              !this.isHorizontal() ? tab.classList.add("vertical") : tab.classList.remove("vertical");
            });
          };
          this.setTabPanels = () => {
            this.tabpanels.forEach((tabpanel, index) => {
              const tabId = this.tabIds[index];
              const tabpanelId = this.tabpanelIds[index];
              tabpanel.setAttribute("id", tabpanelId);
              tabpanel.setAttribute("aria-labelledby", tabId);
              this.activeTabIndex !== index ? tabpanel.setAttribute("hidden", "") : tabpanel.removeAttribute("hidden");
            });
          };
          this.handleTabClick = (event) => {
            const selectedTab = event.currentTarget;
            if (selectedTab.nodeType === 1 && this.isFocusableElement(selectedTab)) {
              this.prevActiveTabIndex = this.activeTabIndex;
              this.activeTabIndex = this.tabs.indexOf(selectedTab);
              this.setComponent();
            }
          };
          this.handleTabKeyDown = (event) => {
            if (this.isHorizontal()) {
              switch (event.key) {
                case keyArrowLeft:
                  event.preventDefault();
                  this.adjustBackward(event);
                  break;
                case keyArrowRight:
                  event.preventDefault();
                  this.adjustForward(event);
                  break;
              }
            } else {
              switch (event.key) {
                case keyArrowUp:
                  event.preventDefault();
                  this.adjustBackward(event);
                  break;
                case keyArrowDown:
                  event.preventDefault();
                  this.adjustForward(event);
                  break;
              }
            }
            switch (event.key) {
              case keyHome:
                event.preventDefault();
                this.adjust(-this.activeTabIndex);
                break;
              case keyEnd:
                event.preventDefault();
                this.adjust(this.tabs.length - this.activeTabIndex - 1);
                break;
            }
          };
          this.adjustForward = (e) => {
            const group = this.tabs;
            let index = 0;
            index = this.activetab ? group.indexOf(this.activetab) + 1 : 1;
            if (index === group.length) {
              index = 0;
            }
            while (index < group.length && group.length > 1) {
              if (this.isFocusableElement(group[index])) {
                this.moveToTabByIndex(group, index);
                break;
              } else if (this.activetab && index === group.indexOf(this.activetab)) {
                break;
              } else if (index + 1 >= group.length) {
                index = 0;
              } else {
                index += 1;
              }
            }
          };
          this.adjustBackward = (e) => {
            const group = this.tabs;
            let index = 0;
            index = this.activetab ? group.indexOf(this.activetab) - 1 : 0;
            index = index < 0 ? group.length - 1 : index;
            while (index >= 0 && group.length > 1) {
              if (this.isFocusableElement(group[index])) {
                this.moveToTabByIndex(group, index);
                break;
              } else if (index - 1 < 0) {
                index = group.length - 1;
              } else {
                index -= 1;
              }
            }
          };
          this.moveToTabByIndex = (group, index) => {
            const tab = group[index];
            this.activetab = tab;
            this.prevActiveTabIndex = this.activeTabIndex;
            this.activeTabIndex = index;
            tab.focus();
            this.setComponent();
          };
        }
        /**
         * @internal
         */
        orientationChanged() {
          if (this.$fastController.isConnected) {
            this.setTabs();
            this.setTabPanels();
            this.handleActiveIndicatorPosition();
          }
        }
        /**
         * @internal
         */
        activeidChanged(oldValue, newValue) {
          if (this.$fastController.isConnected && this.tabs.length <= this.tabpanels.length) {
            this.prevActiveTabIndex = this.tabs.findIndex((item) => item.id === oldValue);
            this.setTabs();
            this.setTabPanels();
            this.handleActiveIndicatorPosition();
          }
        }
        /**
         * @internal
         */
        tabsChanged() {
          if (this.$fastController.isConnected && this.tabs.length <= this.tabpanels.length) {
            this.tabIds = this.getTabIds();
            this.tabpanelIds = this.getTabPanelIds();
            this.setTabs();
            this.setTabPanels();
            this.handleActiveIndicatorPosition();
          }
        }
        /**
         * @internal
         */
        tabpanelsChanged() {
          if (this.$fastController.isConnected && this.tabpanels.length <= this.tabs.length) {
            this.tabIds = this.getTabIds();
            this.tabpanelIds = this.getTabPanelIds();
            this.setTabs();
            this.setTabPanels();
            this.handleActiveIndicatorPosition();
          }
        }
        getActiveIndex() {
          const id = this.activeid;
          if (id !== void 0) {
            return this.tabIds.indexOf(this.activeid) === -1 ? 0 : this.tabIds.indexOf(this.activeid);
          } else {
            return 0;
          }
        }
        getTabIds() {
          return this.tabs.map((tab) => {
            var _a;
            return (_a = tab.getAttribute("id")) !== null && _a !== void 0 ? _a : `tab-${uniqueId()}`;
          });
        }
        getTabPanelIds() {
          return this.tabpanels.map((tabPanel) => {
            var _a;
            return (_a = tabPanel.getAttribute("id")) !== null && _a !== void 0 ? _a : `panel-${uniqueId()}`;
          });
        }
        setComponent() {
          if (this.activeTabIndex !== this.prevActiveTabIndex) {
            this.activeid = this.tabIds[this.activeTabIndex];
            this.focusTab();
            this.change();
          }
        }
        isHorizontal() {
          return this.orientation === TabsOrientation.horizontal;
        }
        handleActiveIndicatorPosition() {
          if (this.showActiveIndicator && this.activeindicator && this.activeTabIndex !== this.prevActiveTabIndex) {
            if (this.ticking) {
              this.ticking = false;
            } else {
              this.ticking = true;
              this.animateActiveIndicator();
            }
          }
        }
        animateActiveIndicator() {
          this.ticking = true;
          const gridProperty = this.isHorizontal() ? "gridColumn" : "gridRow";
          const translateProperty = this.isHorizontal() ? "translateX" : "translateY";
          const offsetProperty = this.isHorizontal() ? "offsetLeft" : "offsetTop";
          const prev = this.activeIndicatorRef[offsetProperty];
          this.activeIndicatorRef.style[gridProperty] = `${this.activeTabIndex + 1}`;
          const next = this.activeIndicatorRef[offsetProperty];
          this.activeIndicatorRef.style[gridProperty] = `${this.prevActiveTabIndex + 1}`;
          const dif = next - prev;
          this.activeIndicatorRef.style.transform = `${translateProperty}(${dif}px)`;
          this.activeIndicatorRef.classList.add("activeIndicatorTransition");
          this.activeIndicatorRef.addEventListener("transitionend", () => {
            this.ticking = false;
            this.activeIndicatorRef.style[gridProperty] = `${this.activeTabIndex + 1}`;
            this.activeIndicatorRef.style.transform = `${translateProperty}(0px)`;
            this.activeIndicatorRef.classList.remove("activeIndicatorTransition");
          });
        }
        /**
         * The adjust method for FASTTabs
         * @public
         * @remarks
         * This method allows the active index to be adjusted by numerical increments
         */
        adjust(adjustment) {
          const focusableTabs = this.tabs.filter((t) => this.isFocusableElement(t));
          const currentActiveTabIndex = focusableTabs.indexOf(this.activetab);
          const nextTabIndex = limit(0, focusableTabs.length - 1, currentActiveTabIndex + adjustment);
          const nextIndex = this.tabs.indexOf(focusableTabs[nextTabIndex]);
          if (nextIndex > -1) {
            this.moveToTabByIndex(this.tabs, nextIndex);
          }
        }
        focusTab() {
          this.tabs[this.activeTabIndex].focus();
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.tabIds = this.getTabIds();
          this.tabpanelIds = this.getTabPanelIds();
          this.activeTabIndex = this.getActiveIndex();
        }
      };
      __decorate([
        attr
      ], Tabs.prototype, "orientation", void 0);
      __decorate([
        attr
      ], Tabs.prototype, "activeid", void 0);
      __decorate([
        observable
      ], Tabs.prototype, "tabs", void 0);
      __decorate([
        observable
      ], Tabs.prototype, "tabpanels", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], Tabs.prototype, "activeindicator", void 0);
      __decorate([
        observable
      ], Tabs.prototype, "activeIndicatorRef", void 0);
      __decorate([
        observable
      ], Tabs.prototype, "showActiveIndicator", void 0);
      applyMixins(Tabs, StartEnd);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tabs/index.js
  var init_tabs2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tabs/index.js"() {
      init_tabs_template();
      init_tabs();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/text-area/text-area.form-associated.js
  var _TextArea, FormAssociatedTextArea;
  var init_text_area_form_associated = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/text-area/text-area.form-associated.js"() {
      init_form_associated();
      init_foundation_element();
      _TextArea = class extends FoundationElement {
      };
      FormAssociatedTextArea = class extends FormAssociated(_TextArea) {
        constructor() {
          super(...arguments);
          this.proxy = document.createElement("textarea");
        }
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/text-area/text-area.options.js
  var TextAreaResize;
  var init_text_area_options = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/text-area/text-area.options.js"() {
      TextAreaResize = {
        /**
         * No resize.
         */
        none: "none",
        /**
         * Resize vertically and horizontally.
         */
        both: "both",
        /**
         * Resize horizontally.
         */
        horizontal: "horizontal",
        /**
         * Resize vertically.
         */
        vertical: "vertical"
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/text-area/text-area.js
  var TextArea;
  var init_text_area = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/text-area/text-area.js"() {
      init_tslib_es6();
      init_esm();
      init_text_field();
      init_apply_mixins();
      init_text_area_form_associated();
      init_text_area_options();
      TextArea = class extends FormAssociatedTextArea {
        constructor() {
          super(...arguments);
          this.resize = TextAreaResize.none;
          this.cols = 20;
          this.handleTextInput = () => {
            this.value = this.control.value;
          };
        }
        readOnlyChanged() {
          if (this.proxy instanceof HTMLTextAreaElement) {
            this.proxy.readOnly = this.readOnly;
          }
        }
        autofocusChanged() {
          if (this.proxy instanceof HTMLTextAreaElement) {
            this.proxy.autofocus = this.autofocus;
          }
        }
        listChanged() {
          if (this.proxy instanceof HTMLTextAreaElement) {
            this.proxy.setAttribute("list", this.list);
          }
        }
        maxlengthChanged() {
          if (this.proxy instanceof HTMLTextAreaElement) {
            this.proxy.maxLength = this.maxlength;
          }
        }
        minlengthChanged() {
          if (this.proxy instanceof HTMLTextAreaElement) {
            this.proxy.minLength = this.minlength;
          }
        }
        spellcheckChanged() {
          if (this.proxy instanceof HTMLTextAreaElement) {
            this.proxy.spellcheck = this.spellcheck;
          }
        }
        /**
         * Selects all the text in the text area
         *
         * @public
         */
        select() {
          this.control.select();
          this.$emit("select");
        }
        /**
         * Change event handler for inner control.
         * @remarks
         * "Change" events are not `composable` so they will not
         * permeate the shadow DOM boundary. This fn effectively proxies
         * the change event, emitting a `change` event whenever the internal
         * control emits a `change` event
         * @internal
         */
        handleChange() {
          this.$emit("change");
        }
        /** {@inheritDoc (FormAssociated:interface).validate} */
        validate() {
          super.validate(this.control);
        }
      };
      __decorate([
        attr({ mode: "boolean" })
      ], TextArea.prototype, "readOnly", void 0);
      __decorate([
        attr
      ], TextArea.prototype, "resize", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], TextArea.prototype, "autofocus", void 0);
      __decorate([
        attr({ attribute: "form" })
      ], TextArea.prototype, "formId", void 0);
      __decorate([
        attr
      ], TextArea.prototype, "list", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], TextArea.prototype, "maxlength", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter })
      ], TextArea.prototype, "minlength", void 0);
      __decorate([
        attr
      ], TextArea.prototype, "name", void 0);
      __decorate([
        attr
      ], TextArea.prototype, "placeholder", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter, mode: "fromView" })
      ], TextArea.prototype, "cols", void 0);
      __decorate([
        attr({ converter: nullableNumberConverter, mode: "fromView" })
      ], TextArea.prototype, "rows", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], TextArea.prototype, "spellcheck", void 0);
      __decorate([
        observable
      ], TextArea.prototype, "defaultSlottedNodes", void 0);
      applyMixins(TextArea, DelegatesARIATextbox);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/text-area/text-area.template.js
  var textAreaTemplate;
  var init_text_area_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/text-area/text-area.template.js"() {
      init_esm();
      init_text_area();
      textAreaTemplate = (context, definition) => html`
    <template
        class="
            ${(x) => x.readOnly ? "readonly" : ""}
            ${(x) => x.resize !== TextAreaResize.none ? `resize-${x.resize}` : ""}"
    >
        <label
            part="label"
            for="control"
            class="${(x) => x.defaultSlottedNodes && x.defaultSlottedNodes.length ? "label" : "label label__hidden"}"
        >
            <slot ${slotted("defaultSlottedNodes")}></slot>
        </label>
        <textarea
            part="control"
            class="control"
            id="control"
            ?autofocus="${(x) => x.autofocus}"
            cols="${(x) => x.cols}"
            ?disabled="${(x) => x.disabled}"
            form="${(x) => x.form}"
            list="${(x) => x.list}"
            maxlength="${(x) => x.maxlength}"
            minlength="${(x) => x.minlength}"
            name="${(x) => x.name}"
            placeholder="${(x) => x.placeholder}"
            ?readonly="${(x) => x.readOnly}"
            ?required="${(x) => x.required}"
            rows="${(x) => x.rows}"
            ?spellcheck="${(x) => x.spellcheck}"
            :value="${(x) => x.value}"
            aria-atomic="${(x) => x.ariaAtomic}"
            aria-busy="${(x) => x.ariaBusy}"
            aria-controls="${(x) => x.ariaControls}"
            aria-current="${(x) => x.ariaCurrent}"
            aria-describedby="${(x) => x.ariaDescribedby}"
            aria-details="${(x) => x.ariaDetails}"
            aria-disabled="${(x) => x.ariaDisabled}"
            aria-errormessage="${(x) => x.ariaErrormessage}"
            aria-flowto="${(x) => x.ariaFlowto}"
            aria-haspopup="${(x) => x.ariaHaspopup}"
            aria-hidden="${(x) => x.ariaHidden}"
            aria-invalid="${(x) => x.ariaInvalid}"
            aria-keyshortcuts="${(x) => x.ariaKeyshortcuts}"
            aria-label="${(x) => x.ariaLabel}"
            aria-labelledby="${(x) => x.ariaLabelledby}"
            aria-live="${(x) => x.ariaLive}"
            aria-owns="${(x) => x.ariaOwns}"
            aria-relevant="${(x) => x.ariaRelevant}"
            aria-roledescription="${(x) => x.ariaRoledescription}"
            @input="${(x, c) => x.handleTextInput()}"
            @change="${(x) => x.handleChange()}"
            ${ref("control")}
        ></textarea>
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/text-area/index.js
  var init_text_area2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/text-area/index.js"() {
      init_text_area_template();
      init_text_area();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/text-field/text-field.template.js
  var textFieldTemplate;
  var init_text_field_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/text-field/text-field.template.js"() {
      init_esm();
      init_start_end();
      init_whitespace_filter();
      textFieldTemplate = (context, definition) => html`
    <template
        class="
            ${(x) => x.readOnly ? "readonly" : ""}
        "
    >
        <label
            part="label"
            for="control"
            class="${(x) => x.defaultSlottedNodes && x.defaultSlottedNodes.length ? "label" : "label label__hidden"}"
        >
            <slot
                ${slotted({ property: "defaultSlottedNodes", filter: whitespaceFilter })}
            ></slot>
        </label>
        <div class="root" part="root">
            ${startSlotTemplate(context, definition)}
            <input
                class="control"
                part="control"
                id="control"
                @input="${(x) => x.handleTextInput()}"
                @change="${(x) => x.handleChange()}"
                ?autofocus="${(x) => x.autofocus}"
                ?disabled="${(x) => x.disabled}"
                list="${(x) => x.list}"
                maxlength="${(x) => x.maxlength}"
                minlength="${(x) => x.minlength}"
                pattern="${(x) => x.pattern}"
                placeholder="${(x) => x.placeholder}"
                ?readonly="${(x) => x.readOnly}"
                ?required="${(x) => x.required}"
                size="${(x) => x.size}"
                ?spellcheck="${(x) => x.spellcheck}"
                :value="${(x) => x.value}"
                type="${(x) => x.type}"
                aria-atomic="${(x) => x.ariaAtomic}"
                aria-busy="${(x) => x.ariaBusy}"
                aria-controls="${(x) => x.ariaControls}"
                aria-current="${(x) => x.ariaCurrent}"
                aria-describedby="${(x) => x.ariaDescribedby}"
                aria-details="${(x) => x.ariaDetails}"
                aria-disabled="${(x) => x.ariaDisabled}"
                aria-errormessage="${(x) => x.ariaErrormessage}"
                aria-flowto="${(x) => x.ariaFlowto}"
                aria-haspopup="${(x) => x.ariaHaspopup}"
                aria-hidden="${(x) => x.ariaHidden}"
                aria-invalid="${(x) => x.ariaInvalid}"
                aria-keyshortcuts="${(x) => x.ariaKeyshortcuts}"
                aria-label="${(x) => x.ariaLabel}"
                aria-labelledby="${(x) => x.ariaLabelledby}"
                aria-live="${(x) => x.ariaLive}"
                aria-owns="${(x) => x.ariaOwns}"
                aria-relevant="${(x) => x.ariaRelevant}"
                aria-roledescription="${(x) => x.ariaRoledescription}"
                ${ref("control")}
            />
            ${endSlotTemplate(context, definition)}
        </div>
    </template>
`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/text-field/index.js
  var init_text_field2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/text-field/index.js"() {
      init_text_field_template();
      init_text_field();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/toolbar/toolbar.template.js
  var init_toolbar_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/toolbar/toolbar.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/root-active-element.js
  function getRootActiveElement(element) {
    const rootNode = element.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      return rootNode.activeElement;
    }
    return document.activeElement;
  }
  var init_root_active_element = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/root-active-element.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/toolbar/toolbar.js
  var ToolbarArrowKeyMap, Toolbar, DelegatesARIAToolbar;
  var init_toolbar = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/toolbar/toolbar.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_index_esm();
      init_foundation_element();
      init_aria_global();
      init_start_end();
      init_apply_mixins();
      init_direction();
      init_root_active_element();
      ToolbarArrowKeyMap = Object.freeze({
        [ArrowKeys.ArrowUp]: {
          [Orientation.vertical]: -1
        },
        [ArrowKeys.ArrowDown]: {
          [Orientation.vertical]: 1
        },
        [ArrowKeys.ArrowLeft]: {
          [Orientation.horizontal]: {
            [Direction.ltr]: -1,
            [Direction.rtl]: 1
          }
        },
        [ArrowKeys.ArrowRight]: {
          [Orientation.horizontal]: {
            [Direction.ltr]: 1,
            [Direction.rtl]: -1
          }
        }
      });
      Toolbar = class _Toolbar extends FoundationElement {
        constructor() {
          super(...arguments);
          this._activeIndex = 0;
          this.direction = Direction.ltr;
          this.orientation = Orientation.horizontal;
        }
        /**
         * The index of the currently focused element, clamped between 0 and the last element.
         *
         * @internal
         */
        get activeIndex() {
          Observable.track(this, "activeIndex");
          return this._activeIndex;
        }
        set activeIndex(value) {
          if (this.$fastController.isConnected) {
            this._activeIndex = limit(0, this.focusableElements.length - 1, value);
            Observable.notify(this, "activeIndex");
          }
        }
        slottedItemsChanged() {
          if (this.$fastController.isConnected) {
            this.reduceFocusableElements();
          }
        }
        /**
         * Set the activeIndex when a focusable element in the toolbar is clicked.
         *
         * @internal
         */
        mouseDownHandler(e) {
          var _a;
          const activeIndex = (_a = this.focusableElements) === null || _a === void 0 ? void 0 : _a.findIndex((x) => x.contains(e.target));
          if (activeIndex > -1 && this.activeIndex !== activeIndex) {
            this.setFocusedElement(activeIndex);
          }
          return true;
        }
        childItemsChanged(prev, next) {
          if (this.$fastController.isConnected) {
            this.reduceFocusableElements();
          }
        }
        /**
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          this.direction = getDirection(this);
        }
        /**
         * When the toolbar receives focus, set the currently active element as focused.
         *
         * @internal
         */
        focusinHandler(e) {
          const relatedTarget = e.relatedTarget;
          if (!relatedTarget || this.contains(relatedTarget)) {
            return;
          }
          this.setFocusedElement();
        }
        /**
         * Determines a value that can be used to iterate a list with the arrow keys.
         *
         * @param this - An element with an orientation and direction
         * @param key - The event key value
         * @internal
         */
        getDirectionalIncrementer(key) {
          var _a, _b, _c, _d, _e;
          return (_e = (_c = (_b = (_a = ToolbarArrowKeyMap[key]) === null || _a === void 0 ? void 0 : _a[this.orientation]) === null || _b === void 0 ? void 0 : _b[this.direction]) !== null && _c !== void 0 ? _c : (_d = ToolbarArrowKeyMap[key]) === null || _d === void 0 ? void 0 : _d[this.orientation]) !== null && _e !== void 0 ? _e : 0;
        }
        /**
         * Handle keyboard events for the toolbar.
         *
         * @internal
         */
        keydownHandler(e) {
          const key = e.key;
          if (!(key in ArrowKeys) || e.defaultPrevented || e.shiftKey) {
            return true;
          }
          const incrementer = this.getDirectionalIncrementer(key);
          if (!incrementer) {
            return !e.target.closest("[role=radiogroup]");
          }
          const nextIndex = this.activeIndex + incrementer;
          if (this.focusableElements[nextIndex]) {
            e.preventDefault();
          }
          this.setFocusedElement(nextIndex);
          return true;
        }
        /**
         * get all the slotted elements
         * @internal
         */
        get allSlottedItems() {
          return [
            ...this.start.assignedElements(),
            ...this.slottedItems,
            ...this.end.assignedElements()
          ];
        }
        /**
         * Prepare the slotted elements which can be focusable.
         *
         * @internal
         */
        reduceFocusableElements() {
          var _a;
          const previousFocusedElement = (_a = this.focusableElements) === null || _a === void 0 ? void 0 : _a[this.activeIndex];
          this.focusableElements = this.allSlottedItems.reduce(_Toolbar.reduceFocusableItems, []);
          const adjustedActiveIndex = this.focusableElements.indexOf(previousFocusedElement);
          this.activeIndex = Math.max(0, adjustedActiveIndex);
          this.setFocusableElements();
        }
        /**
         * Set the activeIndex and focus the corresponding control.
         *
         * @param activeIndex - The new index to set
         * @internal
         */
        setFocusedElement(activeIndex = this.activeIndex) {
          this.activeIndex = activeIndex;
          this.setFocusableElements();
          if (this.focusableElements[this.activeIndex] && // Don't focus the toolbar element if some event handlers moved
          // the focus on another element in the page.
          this.contains(getRootActiveElement(this))) {
            this.focusableElements[this.activeIndex].focus();
          }
        }
        /**
         * Reduce a collection to only its focusable elements.
         *
         * @param elements - Collection of elements to reduce
         * @param element - The current element
         *
         * @internal
         */
        static reduceFocusableItems(elements2, element) {
          var _a, _b, _c, _d;
          const isRoleRadio = element.getAttribute("role") === "radio";
          const isFocusableFastElement = (_b = (_a = element.$fastController) === null || _a === void 0 ? void 0 : _a.definition.shadowOptions) === null || _b === void 0 ? void 0 : _b.delegatesFocus;
          const hasFocusableShadow = Array.from((_d = (_c = element.shadowRoot) === null || _c === void 0 ? void 0 : _c.querySelectorAll("*")) !== null && _d !== void 0 ? _d : []).some((x) => isFocusable(x));
          if (!element.hasAttribute("disabled") && !element.hasAttribute("hidden") && (isFocusable(element) || isRoleRadio || isFocusableFastElement || hasFocusableShadow)) {
            elements2.push(element);
            return elements2;
          }
          if (element.childElementCount) {
            return elements2.concat(Array.from(element.children).reduce(_Toolbar.reduceFocusableItems, []));
          }
          return elements2;
        }
        /**
         * @internal
         */
        setFocusableElements() {
          if (this.$fastController.isConnected && this.focusableElements.length > 0) {
            this.focusableElements.forEach((element, index) => {
              element.tabIndex = this.activeIndex === index ? 0 : -1;
            });
          }
        }
      };
      __decorate([
        observable
      ], Toolbar.prototype, "direction", void 0);
      __decorate([
        attr
      ], Toolbar.prototype, "orientation", void 0);
      __decorate([
        observable
      ], Toolbar.prototype, "slottedItems", void 0);
      __decorate([
        observable
      ], Toolbar.prototype, "slottedLabel", void 0);
      __decorate([
        observable
      ], Toolbar.prototype, "childItems", void 0);
      DelegatesARIAToolbar = class {
      };
      __decorate([
        attr({ attribute: "aria-labelledby" })
      ], DelegatesARIAToolbar.prototype, "ariaLabelledby", void 0);
      __decorate([
        attr({ attribute: "aria-label" })
      ], DelegatesARIAToolbar.prototype, "ariaLabel", void 0);
      applyMixins(DelegatesARIAToolbar, ARIAGlobalStatesAndProperties);
      applyMixins(Toolbar, StartEnd, DelegatesARIAToolbar);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/toolbar/index.js
  var init_toolbar2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/toolbar/index.js"() {
      init_toolbar_template();
      init_toolbar();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tooltip/tooltip.template.js
  var init_tooltip_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tooltip/tooltip.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tooltip/tooltip.options.js
  var TooltipPosition;
  var init_tooltip_options = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tooltip/tooltip.options.js"() {
      TooltipPosition = {
        /**
         * The tooltip is positioned above the element
         */
        top: "top",
        /**
         * The tooltip is positioned to the right of the element
         */
        right: "right",
        /**
         * The tooltip is positioned below the element
         */
        bottom: "bottom",
        /**
         * The tooltip is positioned to the left of the element
         */
        left: "left",
        /**
         * The tooltip is positioned before the element
         */
        start: "start",
        /**
         * The tooltip is positioned after the element
         */
        end: "end",
        /**
         * The tooltip is positioned above the element and to the left
         */
        topLeft: "top-left",
        /**
         * The tooltip is positioned above the element and to the right
         */
        topRight: "top-right",
        /**
         * The tooltip is positioned below the element and to the left
         */
        bottomLeft: "bottom-left",
        /**
         * The tooltip is positioned below the element and to the right
         */
        bottomRight: "bottom-right",
        /**
         * The tooltip is positioned above the element and to the left
         */
        topStart: "top-start",
        /**
         * The tooltip is positioned above the element and to the right
         */
        topEnd: "top-end",
        /**
         * The tooltip is positioned below the element and to the left
         */
        bottomStart: "bottom-start",
        /**
         * The tooltip is positioned below the element and to the right
         */
        bottomEnd: "bottom-end"
      };
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tooltip/tooltip.js
  var Tooltip;
  var init_tooltip = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tooltip/tooltip.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_direction();
      init_foundation_element();
      init_tooltip_options();
      Tooltip = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.anchor = "";
          this.delay = 300;
          this.autoUpdateMode = "anchor";
          this.anchorElement = null;
          this.viewportElement = null;
          this.verticalPositioningMode = "dynamic";
          this.horizontalPositioningMode = "dynamic";
          this.horizontalInset = "false";
          this.verticalInset = "false";
          this.horizontalScaling = "content";
          this.verticalScaling = "content";
          this.verticalDefaultPosition = void 0;
          this.horizontalDefaultPosition = void 0;
          this.tooltipVisible = false;
          this.currentDirection = Direction.ltr;
          this.showDelayTimer = null;
          this.hideDelayTimer = null;
          this.isAnchorHoveredFocused = false;
          this.isRegionHovered = false;
          this.handlePositionChange = (ev) => {
            this.classList.toggle("top", this.region.verticalPosition === "start");
            this.classList.toggle("bottom", this.region.verticalPosition === "end");
            this.classList.toggle("inset-top", this.region.verticalPosition === "insetStart");
            this.classList.toggle("inset-bottom", this.region.verticalPosition === "insetEnd");
            this.classList.toggle("center-vertical", this.region.verticalPosition === "center");
            this.classList.toggle("left", this.region.horizontalPosition === "start");
            this.classList.toggle("right", this.region.horizontalPosition === "end");
            this.classList.toggle("inset-left", this.region.horizontalPosition === "insetStart");
            this.classList.toggle("inset-right", this.region.horizontalPosition === "insetEnd");
            this.classList.toggle("center-horizontal", this.region.horizontalPosition === "center");
          };
          this.handleRegionMouseOver = (ev) => {
            this.isRegionHovered = true;
          };
          this.handleRegionMouseOut = (ev) => {
            this.isRegionHovered = false;
            this.startHideDelayTimer();
          };
          this.handleAnchorMouseOver = (ev) => {
            if (this.tooltipVisible) {
              this.isAnchorHoveredFocused = true;
              return;
            }
            this.startShowDelayTimer();
          };
          this.handleAnchorMouseOut = (ev) => {
            this.isAnchorHoveredFocused = false;
            this.clearShowDelayTimer();
            this.startHideDelayTimer();
          };
          this.handleAnchorFocusIn = (ev) => {
            this.startShowDelayTimer();
          };
          this.handleAnchorFocusOut = (ev) => {
            this.isAnchorHoveredFocused = false;
            this.clearShowDelayTimer();
            this.startHideDelayTimer();
          };
          this.startHideDelayTimer = () => {
            this.clearHideDelayTimer();
            if (!this.tooltipVisible) {
              return;
            }
            this.hideDelayTimer = window.setTimeout(() => {
              this.updateTooltipVisibility();
            }, 60);
          };
          this.clearHideDelayTimer = () => {
            if (this.hideDelayTimer !== null) {
              clearTimeout(this.hideDelayTimer);
              this.hideDelayTimer = null;
            }
          };
          this.startShowDelayTimer = () => {
            if (this.isAnchorHoveredFocused) {
              return;
            }
            if (this.delay > 1) {
              if (this.showDelayTimer === null)
                this.showDelayTimer = window.setTimeout(() => {
                  this.startHover();
                }, this.delay);
              return;
            }
            this.startHover();
          };
          this.startHover = () => {
            this.isAnchorHoveredFocused = true;
            this.updateTooltipVisibility();
          };
          this.clearShowDelayTimer = () => {
            if (this.showDelayTimer !== null) {
              clearTimeout(this.showDelayTimer);
              this.showDelayTimer = null;
            }
          };
          this.getAnchor = () => {
            const rootNode = this.getRootNode();
            if (rootNode instanceof ShadowRoot) {
              return rootNode.getElementById(this.anchor);
            }
            return document.getElementById(this.anchor);
          };
          this.handleDocumentKeydown = (e) => {
            if (!e.defaultPrevented && this.tooltipVisible) {
              switch (e.key) {
                case keyEscape:
                  this.isAnchorHoveredFocused = false;
                  this.updateTooltipVisibility();
                  this.$emit("dismiss");
                  break;
              }
            }
          };
          this.updateTooltipVisibility = () => {
            if (this.visible === false) {
              this.hideTooltip();
            } else if (this.visible === true) {
              this.showTooltip();
              return;
            } else {
              if (this.isAnchorHoveredFocused || this.isRegionHovered) {
                this.showTooltip();
                return;
              }
              this.hideTooltip();
            }
          };
          this.showTooltip = () => {
            if (this.tooltipVisible) {
              return;
            }
            this.currentDirection = getDirection(this);
            this.tooltipVisible = true;
            document.addEventListener("keydown", this.handleDocumentKeydown);
            DOM.queueUpdate(this.setRegionProps);
          };
          this.hideTooltip = () => {
            if (!this.tooltipVisible) {
              return;
            }
            this.clearHideDelayTimer();
            if (this.region !== null && this.region !== void 0) {
              this.region.removeEventListener("positionchange", this.handlePositionChange);
              this.region.viewportElement = null;
              this.region.anchorElement = null;
              this.region.removeEventListener("mouseover", this.handleRegionMouseOver);
              this.region.removeEventListener("mouseout", this.handleRegionMouseOut);
            }
            document.removeEventListener("keydown", this.handleDocumentKeydown);
            this.tooltipVisible = false;
          };
          this.setRegionProps = () => {
            if (!this.tooltipVisible) {
              return;
            }
            this.region.viewportElement = this.viewportElement;
            this.region.anchorElement = this.anchorElement;
            this.region.addEventListener("positionchange", this.handlePositionChange);
            this.region.addEventListener("mouseover", this.handleRegionMouseOver, {
              passive: true
            });
            this.region.addEventListener("mouseout", this.handleRegionMouseOut, {
              passive: true
            });
          };
        }
        visibleChanged() {
          if (this.$fastController.isConnected) {
            this.updateTooltipVisibility();
            this.updateLayout();
          }
        }
        anchorChanged() {
          if (this.$fastController.isConnected) {
            this.anchorElement = this.getAnchor();
          }
        }
        positionChanged() {
          if (this.$fastController.isConnected) {
            this.updateLayout();
          }
        }
        anchorElementChanged(oldValue) {
          if (this.$fastController.isConnected) {
            if (oldValue !== null && oldValue !== void 0) {
              oldValue.removeEventListener("mouseover", this.handleAnchorMouseOver);
              oldValue.removeEventListener("mouseout", this.handleAnchorMouseOut);
              oldValue.removeEventListener("focusin", this.handleAnchorFocusIn);
              oldValue.removeEventListener("focusout", this.handleAnchorFocusOut);
            }
            if (this.anchorElement !== null && this.anchorElement !== void 0) {
              this.anchorElement.addEventListener("mouseover", this.handleAnchorMouseOver, { passive: true });
              this.anchorElement.addEventListener("mouseout", this.handleAnchorMouseOut, { passive: true });
              this.anchorElement.addEventListener("focusin", this.handleAnchorFocusIn, {
                passive: true
              });
              this.anchorElement.addEventListener("focusout", this.handleAnchorFocusOut, { passive: true });
              const anchorId = this.anchorElement.id;
              if (this.anchorElement.parentElement !== null) {
                this.anchorElement.parentElement.querySelectorAll(":hover").forEach((element) => {
                  if (element.id === anchorId) {
                    this.startShowDelayTimer();
                  }
                });
              }
            }
            if (this.region !== null && this.region !== void 0 && this.tooltipVisible) {
              this.region.anchorElement = this.anchorElement;
            }
            this.updateLayout();
          }
        }
        viewportElementChanged() {
          if (this.region !== null && this.region !== void 0) {
            this.region.viewportElement = this.viewportElement;
          }
          this.updateLayout();
        }
        connectedCallback() {
          super.connectedCallback();
          this.anchorElement = this.getAnchor();
          this.updateTooltipVisibility();
        }
        disconnectedCallback() {
          this.hideTooltip();
          this.clearShowDelayTimer();
          this.clearHideDelayTimer();
          super.disconnectedCallback();
        }
        /**
         * updated the properties being passed to the anchored region
         */
        updateLayout() {
          this.verticalPositioningMode = "locktodefault";
          this.horizontalPositioningMode = "locktodefault";
          switch (this.position) {
            case TooltipPosition.top:
            case TooltipPosition.bottom:
              this.verticalDefaultPosition = this.position;
              this.horizontalDefaultPosition = "center";
              break;
            case TooltipPosition.right:
            case TooltipPosition.left:
            case TooltipPosition.start:
            case TooltipPosition.end:
              this.verticalDefaultPosition = "center";
              this.horizontalDefaultPosition = this.position;
              break;
            case TooltipPosition.topLeft:
              this.verticalDefaultPosition = "top";
              this.horizontalDefaultPosition = "left";
              break;
            case TooltipPosition.topRight:
              this.verticalDefaultPosition = "top";
              this.horizontalDefaultPosition = "right";
              break;
            case TooltipPosition.bottomLeft:
              this.verticalDefaultPosition = "bottom";
              this.horizontalDefaultPosition = "left";
              break;
            case TooltipPosition.bottomRight:
              this.verticalDefaultPosition = "bottom";
              this.horizontalDefaultPosition = "right";
              break;
            case TooltipPosition.topStart:
              this.verticalDefaultPosition = "top";
              this.horizontalDefaultPosition = "start";
              break;
            case TooltipPosition.topEnd:
              this.verticalDefaultPosition = "top";
              this.horizontalDefaultPosition = "end";
              break;
            case TooltipPosition.bottomStart:
              this.verticalDefaultPosition = "bottom";
              this.horizontalDefaultPosition = "start";
              break;
            case TooltipPosition.bottomEnd:
              this.verticalDefaultPosition = "bottom";
              this.horizontalDefaultPosition = "end";
              break;
            default:
              this.verticalPositioningMode = "dynamic";
              this.horizontalPositioningMode = "dynamic";
              this.verticalDefaultPosition = void 0;
              this.horizontalDefaultPosition = "center";
              break;
          }
        }
      };
      __decorate([
        attr({ mode: "boolean" })
      ], Tooltip.prototype, "visible", void 0);
      __decorate([
        attr
      ], Tooltip.prototype, "anchor", void 0);
      __decorate([
        attr
      ], Tooltip.prototype, "delay", void 0);
      __decorate([
        attr
      ], Tooltip.prototype, "position", void 0);
      __decorate([
        attr({ attribute: "auto-update-mode" })
      ], Tooltip.prototype, "autoUpdateMode", void 0);
      __decorate([
        attr({ attribute: "horizontal-viewport-lock" })
      ], Tooltip.prototype, "horizontalViewportLock", void 0);
      __decorate([
        attr({ attribute: "vertical-viewport-lock" })
      ], Tooltip.prototype, "verticalViewportLock", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "anchorElement", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "viewportElement", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "verticalPositioningMode", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "horizontalPositioningMode", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "horizontalInset", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "verticalInset", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "horizontalScaling", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "verticalScaling", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "verticalDefaultPosition", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "horizontalDefaultPosition", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "tooltipVisible", void 0);
      __decorate([
        observable
      ], Tooltip.prototype, "currentDirection", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tooltip/index.js
  var init_tooltip2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tooltip/index.js"() {
      init_tooltip_template();
      init_tooltip();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tree-item/tree-item.template.js
  var init_tree_item_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tree-item/tree-item.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tree-item/tree-item.js
  function isTreeItemElement(el) {
    return isHTMLElement(el) && el.getAttribute("role") === "treeitem";
  }
  var TreeItem;
  var init_tree_item = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tree-item/tree-item.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_start_end();
      init_apply_mixins();
      init_foundation_element();
      TreeItem = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.expanded = false;
          this.focusable = false;
          this.isNestedItem = () => {
            return isTreeItemElement(this.parentElement);
          };
          this.handleExpandCollapseButtonClick = (e) => {
            if (!this.disabled && !e.defaultPrevented) {
              this.expanded = !this.expanded;
            }
          };
          this.handleFocus = (e) => {
            this.setAttribute("tabindex", "0");
          };
          this.handleBlur = (e) => {
            this.setAttribute("tabindex", "-1");
          };
        }
        expandedChanged() {
          if (this.$fastController.isConnected) {
            this.$emit("expanded-change", this);
          }
        }
        selectedChanged() {
          if (this.$fastController.isConnected) {
            this.$emit("selected-change", this);
          }
        }
        itemsChanged(oldValue, newValue) {
          if (this.$fastController.isConnected) {
            this.items.forEach((node) => {
              if (isTreeItemElement(node)) {
                node.nested = true;
              }
            });
          }
        }
        /**
         * Places document focus on a tree item
         *
         * @public
         * @param el - the element to focus
         */
        static focusItem(el) {
          el.focusable = true;
          el.focus();
        }
        /**
         * Gets number of children
         *
         * @internal
         */
        childItemLength() {
          const treeChildren = this.childItems.filter((item) => {
            return isTreeItemElement(item);
          });
          return treeChildren ? treeChildren.length : 0;
        }
      };
      __decorate([
        attr({ mode: "boolean" })
      ], TreeItem.prototype, "expanded", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], TreeItem.prototype, "selected", void 0);
      __decorate([
        attr({ mode: "boolean" })
      ], TreeItem.prototype, "disabled", void 0);
      __decorate([
        observable
      ], TreeItem.prototype, "focusable", void 0);
      __decorate([
        observable
      ], TreeItem.prototype, "childItems", void 0);
      __decorate([
        observable
      ], TreeItem.prototype, "items", void 0);
      __decorate([
        observable
      ], TreeItem.prototype, "nested", void 0);
      __decorate([
        observable
      ], TreeItem.prototype, "renderCollapsedChildren", void 0);
      applyMixins(TreeItem, StartEnd);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tree-item/index.js
  var init_tree_item2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tree-item/index.js"() {
      init_tree_item_template();
      init_tree_item();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tree-view/tree-view.template.js
  var init_tree_view_template = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tree-view/tree-view.template.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tree-view/tree-view.js
  var TreeView;
  var init_tree_view = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tree-view/tree-view.js"() {
      init_tslib_es6();
      init_esm();
      init_dist2();
      init_tree_item();
      init_foundation_element();
      TreeView = class extends FoundationElement {
        constructor() {
          super(...arguments);
          this.currentFocused = null;
          this.handleFocus = (e) => {
            if (this.slottedTreeItems.length < 1) {
              return;
            }
            if (e.target === this) {
              if (this.currentFocused === null) {
                this.currentFocused = this.getValidFocusableItem();
              }
              if (this.currentFocused !== null) {
                TreeItem.focusItem(this.currentFocused);
              }
              return;
            }
            if (this.contains(e.target)) {
              this.setAttribute("tabindex", "-1");
              this.currentFocused = e.target;
            }
          };
          this.handleBlur = (e) => {
            if (e.target instanceof HTMLElement && (e.relatedTarget === null || !this.contains(e.relatedTarget))) {
              this.setAttribute("tabindex", "0");
            }
          };
          this.handleKeyDown = (e) => {
            if (e.defaultPrevented) {
              return;
            }
            if (this.slottedTreeItems.length < 1) {
              return true;
            }
            const treeItems = this.getVisibleNodes();
            switch (e.key) {
              case keyHome:
                if (treeItems.length) {
                  TreeItem.focusItem(treeItems[0]);
                }
                return;
              case keyEnd:
                if (treeItems.length) {
                  TreeItem.focusItem(treeItems[treeItems.length - 1]);
                }
                return;
              case keyArrowLeft:
                if (e.target && this.isFocusableElement(e.target)) {
                  const item = e.target;
                  if (item instanceof TreeItem && item.childItemLength() > 0 && item.expanded) {
                    item.expanded = false;
                  } else if (item instanceof TreeItem && item.parentElement instanceof TreeItem) {
                    TreeItem.focusItem(item.parentElement);
                  }
                }
                return false;
              case keyArrowRight:
                if (e.target && this.isFocusableElement(e.target)) {
                  const item = e.target;
                  if (item instanceof TreeItem && item.childItemLength() > 0 && !item.expanded) {
                    item.expanded = true;
                  } else if (item instanceof TreeItem && item.childItemLength() > 0) {
                    this.focusNextNode(1, e.target);
                  }
                }
                return;
              case keyArrowDown:
                if (e.target && this.isFocusableElement(e.target)) {
                  this.focusNextNode(1, e.target);
                }
                return;
              case keyArrowUp:
                if (e.target && this.isFocusableElement(e.target)) {
                  this.focusNextNode(-1, e.target);
                }
                return;
              case keyEnter:
                this.handleClick(e);
                return;
            }
            return true;
          };
          this.handleSelectedChange = (e) => {
            if (e.defaultPrevented) {
              return;
            }
            if (!(e.target instanceof Element) || !isTreeItemElement(e.target)) {
              return true;
            }
            const item = e.target;
            if (item.selected) {
              if (this.currentSelected && this.currentSelected !== item) {
                this.currentSelected.selected = false;
              }
              this.currentSelected = item;
            } else if (!item.selected && this.currentSelected === item) {
              this.currentSelected = null;
            }
            return;
          };
          this.setItems = () => {
            const selectedItem = this.treeView.querySelector("[aria-selected='true']");
            this.currentSelected = selectedItem;
            if (this.currentFocused === null || !this.contains(this.currentFocused)) {
              this.currentFocused = this.getValidFocusableItem();
            }
            this.nested = this.checkForNestedItems();
            const treeItems = this.getVisibleNodes();
            treeItems.forEach((node) => {
              if (isTreeItemElement(node)) {
                node.nested = this.nested;
              }
            });
          };
          this.isFocusableElement = (el) => {
            return isTreeItemElement(el);
          };
          this.isSelectedElement = (el) => {
            return el.selected;
          };
        }
        slottedTreeItemsChanged() {
          if (this.$fastController.isConnected) {
            this.setItems();
          }
        }
        connectedCallback() {
          super.connectedCallback();
          this.setAttribute("tabindex", "0");
          DOM.queueUpdate(() => {
            this.setItems();
          });
        }
        /**
         * Handles click events bubbling up
         *
         *  @internal
         */
        handleClick(e) {
          if (e.defaultPrevented) {
            return;
          }
          if (!(e.target instanceof Element) || !isTreeItemElement(e.target)) {
            return true;
          }
          const item = e.target;
          if (!item.disabled) {
            item.selected = !item.selected;
          }
          return;
        }
        /**
         * Move focus to a tree item based on its offset from the provided item
         */
        focusNextNode(delta, item) {
          const visibleNodes = this.getVisibleNodes();
          if (!visibleNodes) {
            return;
          }
          const focusItem = visibleNodes[visibleNodes.indexOf(item) + delta];
          if (isHTMLElement(focusItem)) {
            TreeItem.focusItem(focusItem);
          }
        }
        /**
         * checks if there are any nested tree items
         */
        getValidFocusableItem() {
          const treeItems = this.getVisibleNodes();
          let focusIndex = treeItems.findIndex(this.isSelectedElement);
          if (focusIndex === -1) {
            focusIndex = treeItems.findIndex(this.isFocusableElement);
          }
          if (focusIndex !== -1) {
            return treeItems[focusIndex];
          }
          return null;
        }
        /**
         * checks if there are any nested tree items
         */
        checkForNestedItems() {
          return this.slottedTreeItems.some((node) => {
            return isTreeItemElement(node) && node.querySelector("[role='treeitem']");
          });
        }
        getVisibleNodes() {
          return getDisplayedNodes(this, "[role='treeitem']") || [];
        }
      };
      __decorate([
        attr({ attribute: "render-collapsed-nodes" })
      ], TreeView.prototype, "renderCollapsedNodes", void 0);
      __decorate([
        observable
      ], TreeView.prototype, "currentSelected", void 0);
      __decorate([
        observable
      ], TreeView.prototype, "slottedTreeItems", void 0);
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/tree-view/index.js
  var init_tree_view2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/tree-view/index.js"() {
      init_tree_view_template();
      init_tree_view();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/match-media-stylesheet-behavior.js
  var MatchMediaBehavior, MatchMediaStyleSheetBehavior, forcedColorsStylesheetBehavior, darkModeStylesheetBehavior, lightModeStylesheetBehavior;
  var init_match_media_stylesheet_behavior = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/match-media-stylesheet-behavior.js"() {
      MatchMediaBehavior = class {
        /**
         *
         * @param query - The media query to operate from.
         */
        constructor(query) {
          this.listenerCache = /* @__PURE__ */ new WeakMap();
          this.query = query;
        }
        /**
         * Binds the behavior to the element.
         * @param source - The element for which the behavior is bound.
         */
        bind(source) {
          const { query } = this;
          const listener = this.constructListener(source);
          listener.bind(query)();
          query.addListener(listener);
          this.listenerCache.set(source, listener);
        }
        /**
         * Unbinds the behavior from the element.
         * @param source - The element for which the behavior is unbinding.
         */
        unbind(source) {
          const listener = this.listenerCache.get(source);
          if (listener) {
            this.query.removeListener(listener);
            this.listenerCache.delete(source);
          }
        }
      };
      MatchMediaStyleSheetBehavior = class _MatchMediaStyleSheetBehavior extends MatchMediaBehavior {
        /**
         * Constructs a {@link MatchMediaStyleSheetBehavior} instance.
         * @param query - The media query to operate from.
         * @param styles - The styles to coordinate with the query.
         */
        constructor(query, styles) {
          super(query);
          this.styles = styles;
        }
        /**
         * Defines a function to construct {@link MatchMediaStyleSheetBehavior | MatchMediaStyleSheetBehaviors} for
         * a provided query.
         * @param query - The media query to operate from.
         *
         * @public
         * @example
         *
         * ```ts
         * import { css } from "@microsoft/fast-element";
         * import { MatchMediaStyleSheetBehavior } from "@microsoft/fast-foundation";
         *
         * const landscapeBehavior = MatchMediaStyleSheetBehavior.with(
         *   window.matchMedia("(orientation: landscape)")
         * );
         * const styles = css`
         *   :host {
         *     width: 200px;
         *     height: 400px;
         *   }
         * `
         * .withBehaviors(landscapeBehavior(css`
         *   :host {
         *     width: 400px;
         *     height: 200px;
         *   }
         * `))
         * ```
         */
        static with(query) {
          return (styles) => {
            return new _MatchMediaStyleSheetBehavior(query, styles);
          };
        }
        /**
         * Constructs a match-media listener for a provided element.
         * @param source - the element for which to attach or detach styles.
         * @internal
         */
        constructListener(source) {
          let attached = false;
          const styles = this.styles;
          return function listener() {
            const { matches: matches2 } = this;
            if (matches2 && !attached) {
              source.$fastController.addStyles(styles);
              attached = matches2;
            } else if (!matches2 && attached) {
              source.$fastController.removeStyles(styles);
              attached = matches2;
            }
          };
        }
        /**
         * Unbinds the behavior from the element.
         * @param source - The element for which the behavior is unbinding.
         * @internal
         */
        unbind(source) {
          super.unbind(source);
          source.$fastController.removeStyles(this.styles);
        }
      };
      forcedColorsStylesheetBehavior = MatchMediaStyleSheetBehavior.with(window.matchMedia("(forced-colors)"));
      darkModeStylesheetBehavior = MatchMediaStyleSheetBehavior.with(window.matchMedia("(prefers-color-scheme: dark)"));
      lightModeStylesheetBehavior = MatchMediaStyleSheetBehavior.with(window.matchMedia("(prefers-color-scheme: light)"));
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/property-stylesheet-behavior.js
  var init_property_stylesheet_behavior = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/property-stylesheet-behavior.js"() {
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/style/disabled.js
  var disabledCursor;
  var init_disabled = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/style/disabled.js"() {
      disabledCursor = "not-allowed";
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/style/display.js
  function display(displayValue) {
    return `${hidden}:host{display:${displayValue}}`;
  }
  var hidden;
  var init_display = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/style/display.js"() {
      hidden = `:host([hidden]){display:none}`;
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/style/focus.js
  var focusVisible;
  var init_focus = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/style/focus.js"() {
      init_dist2();
      focusVisible = canUseFocusVisible() ? "focus-visible" : "focus";
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/style/index.js
  var init_style = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/style/index.js"() {
      init_disabled();
      init_display();
      init_focus();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/utilities/index.js
  var init_utilities = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/utilities/index.js"() {
      init_apply_mixins();
      init_composed_parent();
      init_match_media_stylesheet_behavior();
      init_property_stylesheet_behavior();
      init_style();
      init_direction();
      init_whitespace_filter();
    }
  });

  // node_modules/@microsoft/fast-foundation/dist/esm/index.js
  var init_esm2 = __esm({
    "node_modules/@microsoft/fast-foundation/dist/esm/index.js"() {
      init_accordion_item2();
      init_accordion2();
      init_anchor2();
      init_anchored_region2();
      init_avatar2();
      init_badge2();
      init_breadcrumb_item2();
      init_breadcrumb2();
      init_button2();
      init_calendar2();
      init_card2();
      init_checkbox2();
      init_combobox2();
      init_data_grid2();
      init_design_system2();
      init_design_token();
      init_di2();
      init_dialog2();
      init_disclosure2();
      init_divider2();
      init_flipper2();
      init_form_associated2();
      init_foundation_element2();
      init_listbox_option2();
      init_listbox2();
      init_picker2();
      init_menu_item2();
      init_menu2();
      init_number_field2();
      init_patterns();
      init_progress_ring();
      init_progress();
      init_radio_group2();
      init_radio2();
      init_horizontal_scroll2();
      init_search2();
      init_select2();
      init_skeleton2();
      init_slider_label2();
      init_slider2();
      init_switch2();
      init_tab_panel2();
      init_tab2();
      init_tabs2();
      init_text_area2();
      init_text_field2();
      init_toolbar2();
      init_tooltip2();
      init_tree_item2();
      init_tree_view2();
      init_utilities();
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/vscode-design-system.js
  function provideVSCodeDesignSystem(element) {
    return DesignSystem.getOrCreate(element).withPrefix("vscode");
  }
  var init_vscode_design_system = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/vscode-design-system.js"() {
      init_esm2();
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/utilities/theme/applyTheme.js
  function initThemeChangeListener(tokenMappings2) {
    window.addEventListener("load", () => {
      const observer = new MutationObserver(() => {
        applyCurrentTheme(tokenMappings2);
      });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["class"]
      });
      applyCurrentTheme(tokenMappings2);
    });
  }
  function applyCurrentTheme(tokenMappings2) {
    const styles = getComputedStyle(document.body);
    const body = document.querySelector("body");
    if (body) {
      const themeKind = body.getAttribute("data-vscode-theme-kind");
      for (const [vscodeTokenName, toolkitToken] of tokenMappings2) {
        let value = styles.getPropertyValue(vscodeTokenName).toString();
        if (themeKind === "vscode-high-contrast") {
          if (value.length === 0 && toolkitToken.name.includes("background")) {
            value = "transparent";
          }
          if (toolkitToken.name === "button-icon-hover-background") {
            value = "transparent";
          }
        } else if (themeKind === "vscode-high-contrast-light") {
          if (value.length === 0 && toolkitToken.name.includes("background")) {
            switch (toolkitToken.name) {
              case "button-primary-hover-background":
                value = "#0F4A85";
                break;
              case "button-secondary-hover-background":
                value = "transparent";
                break;
              case "button-icon-hover-background":
                value = "transparent";
                break;
            }
          }
        } else {
          if (toolkitToken.name === "contrast-active-border") {
            value = "transparent";
          }
        }
        toolkitToken.setValueFor(body, value);
      }
    }
  }
  var init_applyTheme = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/utilities/theme/applyTheme.js"() {
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/utilities/design-tokens/create.js
  function create2(name, vscodeThemeVar) {
    const designToken = DesignToken.create(name);
    if (vscodeThemeVar) {
      if (vscodeThemeVar.includes("--fake-vscode-token")) {
        const uniqueId2 = "id" + Math.random().toString(16).slice(2);
        vscodeThemeVar = `${vscodeThemeVar}-${uniqueId2}`;
      }
      tokenMappings.set(vscodeThemeVar, designToken);
    }
    if (!isThemeListenerInitialized) {
      initThemeChangeListener(tokenMappings);
      isThemeListenerInitialized = true;
    }
    return designToken;
  }
  var tokenMappings, isThemeListenerInitialized;
  var init_create = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/utilities/design-tokens/create.js"() {
      init_esm2();
      init_applyTheme();
      tokenMappings = /* @__PURE__ */ new Map();
      isThemeListenerInitialized = false;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/design-tokens.js
  var background, borderWidth, contrastActiveBorder, contrastBorder, cornerRadius, cornerRadiusRound, designUnit, disabledOpacity, focusBorder, fontFamily, fontWeight, foreground, inputHeight, inputMinWidth, typeRampBaseFontSize, typeRampBaseLineHeight, typeRampMinus1FontSize, typeRampMinus1LineHeight, typeRampMinus2FontSize, typeRampMinus2LineHeight, typeRampPlus1FontSize, typeRampPlus1LineHeight, scrollbarWidth, scrollbarHeight, scrollbarSliderBackground, scrollbarSliderHoverBackground, scrollbarSliderActiveBackground, badgeBackground, badgeForeground, buttonBorder, buttonIconBackground, buttonIconCornerRadius, buttonIconFocusBorderOffset, buttonIconHoverBackground, buttonIconPadding, buttonPrimaryBackground, buttonPrimaryForeground, buttonPrimaryHoverBackground, buttonSecondaryBackground, buttonSecondaryForeground, buttonSecondaryHoverBackground, buttonPaddingHorizontal, buttonPaddingVertical, checkboxBackground, checkboxBorder, checkboxCornerRadius, checkboxForeground, listActiveSelectionBackground, listActiveSelectionForeground, listHoverBackground, dividerBackground, dropdownBackground, dropdownBorder, dropdownForeground, dropdownListMaxHeight, inputBackground, inputForeground, inputPlaceholderForeground, linkActiveForeground, linkForeground, progressBackground, panelTabActiveBorder, panelTabActiveForeground, panelTabForeground, panelViewBackground, panelViewBorder, tagCornerRadius;
  var init_design_tokens = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/design-tokens.js"() {
      init_create();
      background = create2("background", "--vscode-editor-background").withDefault("#1e1e1e");
      borderWidth = create2("border-width").withDefault(1);
      contrastActiveBorder = create2("contrast-active-border", "--vscode-contrastActiveBorder").withDefault("#f38518");
      contrastBorder = create2("contrast-border", "--vscode-contrastBorder").withDefault("#6fc3df");
      cornerRadius = create2("corner-radius").withDefault(0);
      cornerRadiusRound = create2("corner-radius-round").withDefault(2);
      designUnit = create2("design-unit").withDefault(4);
      disabledOpacity = create2("disabled-opacity").withDefault(0.4);
      focusBorder = create2("focus-border", "--vscode-focusBorder").withDefault("#007fd4");
      fontFamily = create2("font-family", "--vscode-font-family").withDefault("-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol");
      fontWeight = create2("font-weight", "--vscode-font-weight").withDefault("400");
      foreground = create2("foreground", "--vscode-foreground").withDefault("#cccccc");
      inputHeight = create2("input-height").withDefault("26");
      inputMinWidth = create2("input-min-width").withDefault("100px");
      typeRampBaseFontSize = create2("type-ramp-base-font-size", "--vscode-font-size").withDefault("13px");
      typeRampBaseLineHeight = create2("type-ramp-base-line-height").withDefault("normal");
      typeRampMinus1FontSize = create2("type-ramp-minus1-font-size").withDefault("11px");
      typeRampMinus1LineHeight = create2("type-ramp-minus1-line-height").withDefault("16px");
      typeRampMinus2FontSize = create2("type-ramp-minus2-font-size").withDefault("9px");
      typeRampMinus2LineHeight = create2("type-ramp-minus2-line-height").withDefault("16px");
      typeRampPlus1FontSize = create2("type-ramp-plus1-font-size").withDefault("16px");
      typeRampPlus1LineHeight = create2("type-ramp-plus1-line-height").withDefault("24px");
      scrollbarWidth = create2("scrollbarWidth").withDefault("10px");
      scrollbarHeight = create2("scrollbarHeight").withDefault("10px");
      scrollbarSliderBackground = create2("scrollbar-slider-background", "--vscode-scrollbarSlider-background").withDefault("#79797966");
      scrollbarSliderHoverBackground = create2("scrollbar-slider-hover-background", "--vscode-scrollbarSlider-hoverBackground").withDefault("#646464b3");
      scrollbarSliderActiveBackground = create2("scrollbar-slider-active-background", "--vscode-scrollbarSlider-activeBackground").withDefault("#bfbfbf66");
      badgeBackground = create2("badge-background", "--vscode-badge-background").withDefault("#4d4d4d");
      badgeForeground = create2("badge-foreground", "--vscode-badge-foreground").withDefault("#ffffff");
      buttonBorder = create2("button-border", "--vscode-button-border").withDefault("transparent");
      buttonIconBackground = create2("button-icon-background").withDefault("transparent");
      buttonIconCornerRadius = create2("button-icon-corner-radius").withDefault("5px");
      buttonIconFocusBorderOffset = create2("button-icon-outline-offset").withDefault(0);
      buttonIconHoverBackground = create2("button-icon-hover-background", "--fake-vscode-token").withDefault("rgba(90, 93, 94, 0.31)");
      buttonIconPadding = create2("button-icon-padding").withDefault("3px");
      buttonPrimaryBackground = create2("button-primary-background", "--vscode-button-background").withDefault("#0e639c");
      buttonPrimaryForeground = create2("button-primary-foreground", "--vscode-button-foreground").withDefault("#ffffff");
      buttonPrimaryHoverBackground = create2("button-primary-hover-background", "--vscode-button-hoverBackground").withDefault("#1177bb");
      buttonSecondaryBackground = create2("button-secondary-background", "--vscode-button-secondaryBackground").withDefault("#3a3d41");
      buttonSecondaryForeground = create2("button-secondary-foreground", "--vscode-button-secondaryForeground").withDefault("#ffffff");
      buttonSecondaryHoverBackground = create2("button-secondary-hover-background", "--vscode-button-secondaryHoverBackground").withDefault("#45494e");
      buttonPaddingHorizontal = create2("button-padding-horizontal").withDefault("11px");
      buttonPaddingVertical = create2("button-padding-vertical").withDefault("4px");
      checkboxBackground = create2("checkbox-background", "--vscode-checkbox-background").withDefault("#3c3c3c");
      checkboxBorder = create2("checkbox-border", "--vscode-checkbox-border").withDefault("#3c3c3c");
      checkboxCornerRadius = create2("checkbox-corner-radius").withDefault(3);
      checkboxForeground = create2("checkbox-foreground", "--vscode-checkbox-foreground").withDefault("#f0f0f0");
      listActiveSelectionBackground = create2("list-active-selection-background", "--vscode-list-activeSelectionBackground").withDefault("#094771");
      listActiveSelectionForeground = create2("list-active-selection-foreground", "--vscode-list-activeSelectionForeground").withDefault("#ffffff");
      listHoverBackground = create2("list-hover-background", "--vscode-list-hoverBackground").withDefault("#2a2d2e");
      dividerBackground = create2("divider-background", "--vscode-settings-dropdownListBorder").withDefault("#454545");
      dropdownBackground = create2("dropdown-background", "--vscode-dropdown-background").withDefault("#3c3c3c");
      dropdownBorder = create2("dropdown-border", "--vscode-dropdown-border").withDefault("#3c3c3c");
      dropdownForeground = create2("dropdown-foreground", "--vscode-dropdown-foreground").withDefault("#f0f0f0");
      dropdownListMaxHeight = create2("dropdown-list-max-height").withDefault("200px");
      inputBackground = create2("input-background", "--vscode-input-background").withDefault("#3c3c3c");
      inputForeground = create2("input-foreground", "--vscode-input-foreground").withDefault("#cccccc");
      inputPlaceholderForeground = create2("input-placeholder-foreground", "--vscode-input-placeholderForeground").withDefault("#cccccc");
      linkActiveForeground = create2("link-active-foreground", "--vscode-textLink-activeForeground").withDefault("#3794ff");
      linkForeground = create2("link-foreground", "--vscode-textLink-foreground").withDefault("#3794ff");
      progressBackground = create2("progress-background", "--vscode-progressBar-background").withDefault("#0e70c0");
      panelTabActiveBorder = create2("panel-tab-active-border", "--vscode-panelTitle-activeBorder").withDefault("#e7e7e7");
      panelTabActiveForeground = create2("panel-tab-active-foreground", "--vscode-panelTitle-activeForeground").withDefault("#e7e7e7");
      panelTabForeground = create2("panel-tab-foreground", "--vscode-panelTitle-inactiveForeground").withDefault("#e7e7e799");
      panelViewBackground = create2("panel-view-background", "--vscode-panel-background").withDefault("#1e1e1e");
      panelViewBorder = create2("panel-view-border", "--vscode-panel-border").withDefault("#80808059");
      tagCornerRadius = create2("tag-corner-radius").withDefault("2px");
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/badge/badge.styles.js
  var badgeStyles;
  var init_badge_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/badge/badge.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      badgeStyles = (context, definition) => css`
	${display("inline-block")} :host {
		box-sizing: border-box;
		font-family: ${fontFamily};
		font-size: ${typeRampMinus1FontSize};
		line-height: ${typeRampMinus1LineHeight};
		text-align: center;
	}
	.control {
		align-items: center;
		background-color: ${badgeBackground};
		border: calc(${borderWidth} * 1px) solid ${buttonBorder};
		border-radius: 11px;
		box-sizing: border-box;
		color: ${badgeForeground};
		display: flex;
		height: calc(${designUnit} * 4px);
		justify-content: center;
		min-width: calc(${designUnit} * 4px + 2px);
		min-height: calc(${designUnit} * 4px + 2px);
		padding: 3px 6px;
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/badge/index.js
  var Badge2, vsCodeBadge;
  var init_badge3 = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/badge/index.js"() {
      init_esm2();
      init_badge_styles();
      Badge2 = class extends Badge {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (!this.circular) {
            this.circular = true;
          }
        }
      };
      vsCodeBadge = Badge2.compose({
        baseName: "badge",
        template: badgeTemplate,
        styles: badgeStyles
      });
    }
  });

  // node_modules/tslib/tslib.es6.mjs
  function __decorate2(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
  }
  var init_tslib_es62 = __esm({
    "node_modules/tslib/tslib.es6.mjs"() {
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/button/button.styles.js
  var BaseButtonStyles, PrimaryButtonStyles, SecondaryButtonStyles, IconButtonStyles, buttonStyles;
  var init_button_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/button/button.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      BaseButtonStyles = css`
	${display("inline-flex")} :host {
		outline: none;
		font-family: ${fontFamily};
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		color: ${buttonPrimaryForeground};
		background: ${buttonPrimaryBackground};
		border-radius: calc(${cornerRadiusRound} * 1px);
		fill: currentColor;
		cursor: pointer;
	}
	.control {
		background: transparent;
		height: inherit;
		flex-grow: 1;
		box-sizing: border-box;
		display: inline-flex;
		justify-content: center;
		align-items: center;
		padding: ${buttonPaddingVertical} ${buttonPaddingHorizontal};
		white-space: wrap;
		outline: none;
		text-decoration: none;
		border: calc(${borderWidth} * 1px) solid ${buttonBorder};
		color: inherit;
		border-radius: inherit;
		fill: inherit;
		cursor: inherit;
		font-family: inherit;
	}
	:host(:hover) {
		background: ${buttonPrimaryHoverBackground};
	}
	:host(:active) {
		background: ${buttonPrimaryBackground};
	}
	.control:${focusVisible} {
		outline: calc(${borderWidth} * 1px) solid ${focusBorder};
		outline-offset: calc(${borderWidth} * 2px);
	}
	.control::-moz-focus-inner {
		border: 0;
	}
	:host([disabled]) {
		opacity: ${disabledOpacity};
		background: ${buttonPrimaryBackground};
		cursor: ${disabledCursor};
	}
	.content {
		display: flex;
	}
	.start {
		display: flex;
	}
	::slotted(svg),
	::slotted(span) {
		width: calc(${designUnit} * 4px);
		height: calc(${designUnit} * 4px);
	}
	.start {
		margin-inline-end: 8px;
	}
`;
      PrimaryButtonStyles = css`
	:host([appearance='primary']) {
		background: ${buttonPrimaryBackground};
		color: ${buttonPrimaryForeground};
	}
	:host([appearance='primary']:hover) {
		background: ${buttonPrimaryHoverBackground};
	}
	:host([appearance='primary']:active) .control:active {
		background: ${buttonPrimaryBackground};
	}
	:host([appearance='primary']) .control:${focusVisible} {
		outline: calc(${borderWidth} * 1px) solid ${focusBorder};
		outline-offset: calc(${borderWidth} * 2px);
	}
	:host([appearance='primary'][disabled]) {
		background: ${buttonPrimaryBackground};
	}
`;
      SecondaryButtonStyles = css`
	:host([appearance='secondary']) {
		background: ${buttonSecondaryBackground};
		color: ${buttonSecondaryForeground};
	}
	:host([appearance='secondary']:hover) {
		background: ${buttonSecondaryHoverBackground};
	}
	:host([appearance='secondary']:active) .control:active {
		background: ${buttonSecondaryBackground};
	}
	:host([appearance='secondary']) .control:${focusVisible} {
		outline: calc(${borderWidth} * 1px) solid ${focusBorder};
		outline-offset: calc(${borderWidth} * 2px);
	}
	:host([appearance='secondary'][disabled]) {
		background: ${buttonSecondaryBackground};
	}
`;
      IconButtonStyles = css`
	:host([appearance='icon']) {
		background: ${buttonIconBackground};
		border-radius: ${buttonIconCornerRadius};
		color: ${foreground};
	}
	:host([appearance='icon']:hover) {
		background: ${buttonIconHoverBackground};
		outline: 1px dotted ${contrastActiveBorder};
		outline-offset: -1px;
	}
	:host([appearance='icon']) .control {
		padding: ${buttonIconPadding};
		border: none;
	}
	:host([appearance='icon']:active) .control:active {
		background: ${buttonIconHoverBackground};
	}
	:host([appearance='icon']) .control:${focusVisible} {
		outline: calc(${borderWidth} * 1px) solid ${focusBorder};
		outline-offset: ${buttonIconFocusBorderOffset};
	}
	:host([appearance='icon'][disabled]) {
		background: ${buttonIconBackground};
	}
`;
      buttonStyles = (context, definition) => css`
	${BaseButtonStyles}
	${PrimaryButtonStyles}
	${SecondaryButtonStyles}
	${IconButtonStyles}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/button/index.js
  var Button2, vsCodeButton;
  var init_button3 = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/button/index.js"() {
      init_tslib_es62();
      init_esm();
      init_esm2();
      init_button_styles();
      Button2 = class extends Button {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (!this.appearance) {
            const appearanceValue = this.getAttribute("appearance");
            this.appearance = appearanceValue;
          }
        }
        /**
         * Component lifecycle method that runs when an attribute of the
         * element is changed.
         *
         * @param attrName - The attribute that was changed
         * @param oldVal - The old value of the attribute
         * @param newVal - The new value of the attribute
         *
         * @internal
         */
        attributeChangedCallback(attrName, oldVal, newVal) {
          if (attrName === "appearance" && newVal === "icon") {
            const ariaLabelValue = this.getAttribute("aria-label");
            if (!ariaLabelValue) {
              this.ariaLabel = "Icon Button";
            }
          }
          if (attrName === "aria-label") {
            this.ariaLabel = newVal;
          }
          if (attrName === "disabled") {
            this.disabled = newVal !== null;
          }
        }
      };
      __decorate2([
        attr
      ], Button2.prototype, "appearance", void 0);
      vsCodeButton = Button2.compose({
        baseName: "button",
        template: buttonTemplate,
        styles: buttonStyles,
        shadowOptions: {
          delegatesFocus: true
        }
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/checkbox/checkbox.styles.js
  var checkboxStyles;
  var init_checkbox_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/checkbox/checkbox.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      checkboxStyles = (context, defintiion) => css`
	${display("inline-flex")} :host {
		align-items: center;
		outline: none;
		margin: calc(${designUnit} * 1px) 0;
		user-select: none;
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
	}
	.control {
		position: relative;
		width: calc(${designUnit} * 4px + 2px);
		height: calc(${designUnit} * 4px + 2px);
		box-sizing: border-box;
		border-radius: calc(${checkboxCornerRadius} * 1px);
		border: calc(${borderWidth} * 1px) solid ${checkboxBorder};
		background: ${checkboxBackground};
		outline: none;
		cursor: pointer;
	}
	.label {
		font-family: ${fontFamily};
		color: ${foreground};
		padding-inline-start: calc(${designUnit} * 2px + 2px);
		margin-inline-end: calc(${designUnit} * 2px + 2px);
		cursor: pointer;
	}
	.label__hidden {
		display: none;
		visibility: hidden;
	}
	.checked-indicator {
		width: 100%;
		height: 100%;
		display: block;
		fill: ${foreground};
		opacity: 0;
		pointer-events: none;
	}
	.indeterminate-indicator {
		border-radius: 2px;
		background: ${foreground};
		position: absolute;
		top: 50%;
		left: 50%;
		width: 50%;
		height: 50%;
		transform: translate(-50%, -50%);
		opacity: 0;
	}
	:host(:enabled) .control:hover {
		background: ${checkboxBackground};
		border-color: ${checkboxBorder};
	}
	:host(:enabled) .control:active {
		background: ${checkboxBackground};
		border-color: ${focusBorder};
	}
	:host(:${focusVisible}) .control {
		border: calc(${borderWidth} * 1px) solid ${focusBorder};
	}
	:host(.disabled) .label,
	:host(.readonly) .label,
	:host(.readonly) .control,
	:host(.disabled) .control {
		cursor: ${disabledCursor};
	}
	:host(.checked:not(.indeterminate)) .checked-indicator,
	:host(.indeterminate) .indeterminate-indicator {
		opacity: 1;
	}
	:host(.disabled) {
		opacity: ${disabledOpacity};
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/checkbox/index.js
  var Checkbox2, vsCodeCheckbox;
  var init_checkbox3 = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/checkbox/index.js"() {
      init_esm2();
      init_checkbox_styles();
      Checkbox2 = class extends Checkbox {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.textContent) {
            this.setAttribute("aria-label", this.textContent);
          } else {
            this.setAttribute("aria-label", "Checkbox");
          }
        }
      };
      vsCodeCheckbox = Checkbox2.compose({
        baseName: "checkbox",
        template: checkboxTemplate,
        styles: checkboxStyles,
        checkedIndicator: `
		<svg 
			part="checked-indicator"
			class="checked-indicator"
			width="16" 
			height="16" 
			viewBox="0 0 16 16" 
			xmlns="http://www.w3.org/2000/svg" 
			fill="currentColor"
		>
			<path 
				fill-rule="evenodd" 
				clip-rule="evenodd" 
				d="M14.431 3.323l-8.47 10-.79-.036-3.35-4.77.818-.574 2.978 4.24 8.051-9.506.764.646z"
			/>
		</svg>
	`,
        indeterminateIndicator: `
		<div part="indeterminate-indicator" class="indeterminate-indicator"></div>
	`
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/data-grid/data-grid.styles.js
  var dataGridStyles;
  var init_data_grid_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/data-grid/data-grid.styles.js"() {
      init_esm();
      dataGridStyles = (context, definition) => css`
	:host {
		display: flex;
		position: relative;
		flex-direction: column;
		width: 100%;
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/data-grid/data-grid-row.styles.js
  var dataGridRowStyles;
  var init_data_grid_row_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/data-grid/data-grid-row.styles.js"() {
      init_esm();
      init_design_tokens();
      dataGridRowStyles = (context, definition) => css`
	:host {
		display: grid;
		padding: calc((${designUnit} / 4) * 1px) 0;
		box-sizing: border-box;
		width: 100%;
		background: transparent;
	}
	:host(.header) {
	}
	:host(.sticky-header) {
		background: ${background};
		position: sticky;
		top: 0;
	}
	:host(:hover) {
		background: ${listHoverBackground};
		outline: 1px dotted ${contrastActiveBorder};
		outline-offset: -1px;
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/data-grid/data-grid-cell.styles.js
  var dataGridCellStyles;
  var init_data_grid_cell_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/data-grid/data-grid-cell.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      dataGridCellStyles = (context, definition) => css`
	:host {
		padding: calc(${designUnit} * 1px) calc(${designUnit} * 3px);
		color: ${foreground};
		opacity: 1;
		box-sizing: border-box;
		font-family: ${fontFamily};
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		font-weight: 400;
		border: solid calc(${borderWidth} * 1px) transparent;
		border-radius: calc(${cornerRadius} * 1px);
		white-space: wrap;
		overflow-wrap: anywhere;
	}
	:host(.column-header) {
		font-weight: 600;
	}
	:host(:${focusVisible}),
	:host(:focus),
	:host(:active) {
		background: ${listActiveSelectionBackground};
		border: solid calc(${borderWidth} * 1px) ${focusBorder};
		color: ${listActiveSelectionForeground};
		outline: none;
	}
	:host(:${focusVisible}) ::slotted(*),
	:host(:focus) ::slotted(*),
	:host(:active) ::slotted(*) {
		color: ${listActiveSelectionForeground} !important;
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/data-grid/index.js
  var DataGrid2, vsCodeDataGrid, DataGridRow2, vsCodeDataGridRow, DataGridCell2, vsCodeDataGridCell;
  var init_data_grid3 = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/data-grid/index.js"() {
      init_esm2();
      init_data_grid_styles();
      init_data_grid_row_styles();
      init_data_grid_cell_styles();
      DataGrid2 = class extends DataGrid {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          const ariaLabelValue = this.getAttribute("aria-label");
          if (!ariaLabelValue) {
            this.setAttribute("aria-label", "Data Grid");
          }
        }
      };
      vsCodeDataGrid = DataGrid2.compose({
        baseName: "data-grid",
        baseClass: DataGrid,
        template: dataGridTemplate,
        styles: dataGridStyles
      });
      DataGridRow2 = class extends DataGridRow {
      };
      vsCodeDataGridRow = DataGridRow2.compose({
        baseName: "data-grid-row",
        baseClass: DataGridRow,
        template: dataGridRowTemplate,
        styles: dataGridRowStyles
      });
      DataGridCell2 = class extends DataGridCell {
      };
      vsCodeDataGridCell = DataGridCell2.compose({
        baseName: "data-grid-cell",
        baseClass: DataGridCell,
        template: dataGridCellTemplate,
        styles: dataGridCellStyles
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/divider/divider.styles.js
  var dividerStyles;
  var init_divider_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/divider/divider.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      dividerStyles = (context, definition) => css`
	${display("block")} :host {
		border: none;
		border-top: calc(${borderWidth} * 1px) solid ${dividerBackground};
		box-sizing: content-box;
		height: 0;
		margin: calc(${designUnit} * 1px) 0;
		width: 100%;
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/divider/index.js
  var Divider2, vsCodeDivider;
  var init_divider3 = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/divider/index.js"() {
      init_esm2();
      init_divider_styles();
      Divider2 = class extends Divider {
      };
      vsCodeDivider = Divider2.compose({
        baseName: "divider",
        template: dividerTemplate,
        styles: dividerStyles
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/dropdown/dropdown.styles.js
  var dropdownStyles;
  var init_dropdown_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/dropdown/dropdown.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      dropdownStyles = (context, definition) => css`
	${display("inline-flex")} :host {
		background: ${dropdownBackground};
		border-radius: calc(${cornerRadiusRound} * 1px);
		box-sizing: border-box;
		color: ${foreground};
		contain: contents;
		font-family: ${fontFamily};
		height: calc(${inputHeight} * 1px);
		position: relative;
		user-select: none;
		min-width: ${inputMinWidth};
		outline: none;
		vertical-align: top;
	}
	.control {
		align-items: center;
		box-sizing: border-box;
		border: calc(${borderWidth} * 1px) solid ${dropdownBorder};
		border-radius: calc(${cornerRadiusRound} * 1px);
		cursor: pointer;
		display: flex;
		font-family: inherit;
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		min-height: 100%;
		padding: 2px 6px 2px 8px;
		width: 100%;
	}
	.listbox {
		background: ${dropdownBackground};
		border: calc(${borderWidth} * 1px) solid ${focusBorder};
		border-radius: calc(${cornerRadiusRound} * 1px);
		box-sizing: border-box;
		display: inline-flex;
		flex-direction: column;
		left: 0;
		max-height: ${dropdownListMaxHeight};
		padding: 0;
		overflow-y: auto;
		position: absolute;
		width: 100%;
		z-index: 1;
	}
	.listbox[hidden] {
		display: none;
	}
	:host(:${focusVisible}) .control {
		border-color: ${focusBorder};
	}
	:host(:not([disabled]):hover) {
		background: ${dropdownBackground};
		border-color: ${dropdownBorder};
	}
	:host(:${focusVisible}) ::slotted([aria-selected="true"][role="option"]:not([disabled])) {
		background: ${listActiveSelectionBackground};
		border: calc(${borderWidth} * 1px) solid transparent;
		color: ${listActiveSelectionForeground};
	}
	:host([disabled]) {
		cursor: ${disabledCursor};
		opacity: ${disabledOpacity};
	}
	:host([disabled]) .control {
		cursor: ${disabledCursor};
		user-select: none;
	}
	:host([disabled]:hover) {
		background: ${dropdownBackground};
		color: ${foreground};
		fill: currentcolor;
	}
	:host(:not([disabled])) .control:active {
		border-color: ${focusBorder};
	}
	:host(:empty) .listbox {
		display: none;
	}
	:host([open]) .control {
		border-color: ${focusBorder};
	}
	:host([open][position='above']) .listbox {
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
	}
	:host([open][position='below']) .listbox {
		border-top-left-radius: 0;
		border-top-right-radius: 0;
	}
	:host([open][position='above']) .listbox {
		bottom: calc(${inputHeight} * 1px);
	}
	:host([open][position='below']) .listbox {
		top: calc(${inputHeight} * 1px);
	}
	.selected-value {
		flex: 1 1 auto;
		font-family: inherit;
		overflow: hidden;
		text-align: start;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.indicator {
		flex: 0 0 auto;
		margin-inline-start: 1em;
	}
	slot[name='listbox'] {
		display: none;
		width: 100%;
	}
	:host([open]) slot[name='listbox'] {
		display: flex;
		position: absolute;
	}
	.end {
		margin-inline-start: auto;
	}
	.start,
	.end,
	.indicator,
	.select-indicator,
	::slotted(svg),
	::slotted(span) {
		fill: currentcolor;
		height: 1em;
		min-height: calc(${designUnit} * 4px);
		min-width: calc(${designUnit} * 4px);
		width: 1em;
	}
	::slotted([role='option']),
	::slotted(option) {
		flex: 0 0 auto;
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/dropdown/index.js
  var Dropdown, vsCodeDropdown;
  var init_dropdown = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/dropdown/index.js"() {
      init_esm2();
      init_dropdown_styles();
      Dropdown = class extends Select {
      };
      vsCodeDropdown = Dropdown.compose({
        baseName: "dropdown",
        template: selectTemplate,
        styles: dropdownStyles,
        indicator: `
		<svg 
			class="select-indicator"
			part="select-indicator"
			width="16" 
			height="16" 
			viewBox="0 0 16 16" 
			xmlns="http://www.w3.org/2000/svg" 
			fill="currentColor"
		>
			<path 
				fill-rule="evenodd" 
				clip-rule="evenodd" 
				d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"
			/>
		</svg>
	`
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/link/link.styles.js
  var linkStyles;
  var init_link_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/link/link.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      linkStyles = (context, definition) => css`
	${display("inline-flex")} :host {
		background: transparent;
		box-sizing: border-box;
		color: ${linkForeground};
		cursor: pointer;
		fill: currentcolor;
		font-family: ${fontFamily};
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		outline: none;
	}
	.control {
		background: transparent;
		border: calc(${borderWidth} * 1px) solid transparent;
		border-radius: calc(${cornerRadius} * 1px);
		box-sizing: border-box;
		color: inherit;
		cursor: inherit;
		fill: inherit;
		font-family: inherit;
		height: inherit;
		padding: 0;
		outline: none;
		text-decoration: none;
		word-break: break-word;
	}
	.control::-moz-focus-inner {
		border: 0;
	}
	:host(:hover) {
		color: ${linkActiveForeground};
	}
	:host(:hover) .content {
		text-decoration: underline;
	}
	:host(:active) {
		background: transparent;
		color: ${linkActiveForeground};
	}
	:host(:${focusVisible}) .control,
	:host(:focus) .control {
		border: calc(${borderWidth} * 1px) solid ${focusBorder};
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/link/index.js
  var Link, vsCodeLink;
  var init_link = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/link/index.js"() {
      init_esm2();
      init_link_styles();
      Link = class extends Anchor {
      };
      vsCodeLink = Link.compose({
        baseName: "link",
        template: anchorTemplate,
        styles: linkStyles,
        shadowOptions: {
          delegatesFocus: true
        }
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/option/option.styles.js
  var optionStyles;
  var init_option_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/option/option.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      optionStyles = (context, definition) => css`
	${display("inline-flex")} :host {
		font-family: var(--body-font);
		border-radius: ${cornerRadius};
		border: calc(${borderWidth} * 1px) solid transparent;
		box-sizing: border-box;
		color: ${foreground};
		cursor: pointer;
		fill: currentcolor;
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		margin: 0;
		outline: none;
		overflow: hidden;
		padding: 0 calc((${designUnit} / 2) * 1px)
			calc((${designUnit} / 4) * 1px);
		user-select: none;
		white-space: nowrap;
	}
	:host(:${focusVisible}) {
		border-color: ${focusBorder};
		background: ${listActiveSelectionBackground};
		color: ${foreground};
	}
	:host([aria-selected='true']) {
		background: ${listActiveSelectionBackground};
		border: calc(${borderWidth} * 1px) solid transparent;
		color: ${listActiveSelectionForeground};
	}
	:host(:active) {
		background: ${listActiveSelectionBackground};
		color: ${listActiveSelectionForeground};
	}
	:host(:not([aria-selected='true']):hover) {
		background: ${listActiveSelectionBackground};
		border: calc(${borderWidth} * 1px) solid transparent;
		color: ${listActiveSelectionForeground};
	}
	:host(:not([aria-selected='true']):active) {
		background: ${listActiveSelectionBackground};
		color: ${foreground};
	}
	:host([disabled]) {
		cursor: ${disabledCursor};
		opacity: ${disabledOpacity};
	}
	:host([disabled]:hover) {
		background-color: inherit;
	}
	.content {
		grid-column-start: 2;
		justify-self: start;
		overflow: hidden;
		text-overflow: ellipsis;
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/option/index.js
  var Option2, vsCodeOption;
  var init_option = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/option/index.js"() {
      init_esm2();
      init_option_styles();
      Option2 = class extends ListboxOption {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.textContent) {
            this.setAttribute("aria-label", this.textContent);
          } else {
            this.setAttribute("aria-label", "Option");
          }
        }
      };
      vsCodeOption = Option2.compose({
        baseName: "option",
        template: listboxOptionTemplate,
        styles: optionStyles
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/panels/panels.styles.js
  var panelsStyles;
  var init_panels_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/panels/panels.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      panelsStyles = (context, definition) => css`
	${display("grid")} :host {
		box-sizing: border-box;
		font-family: ${fontFamily};
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		color: ${foreground};
		grid-template-columns: auto 1fr auto;
		grid-template-rows: auto 1fr;
		overflow-x: auto;
	}
	.tablist {
		display: grid;
		grid-template-rows: auto auto;
		grid-template-columns: auto;
		column-gap: calc(${designUnit} * 8px);
		position: relative;
		width: max-content;
		align-self: end;
		padding: calc(${designUnit} * 1px) calc(${designUnit} * 1px) 0;
		box-sizing: border-box;
	}
	.start,
	.end {
		align-self: center;
	}
	.activeIndicator {
		grid-row: 2;
		grid-column: 1;
		width: 100%;
		height: calc((${designUnit} / 4) * 1px);
		justify-self: center;
		background: ${panelTabActiveForeground};
		margin: 0;
		border-radius: calc(${cornerRadius} * 1px);
	}
	.activeIndicatorTransition {
		transition: transform 0.01s linear;
	}
	.tabpanel {
		grid-row: 2;
		grid-column-start: 1;
		grid-column-end: 4;
		position: relative;
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/panels/panel-tab.styles.js
  var panelTabStyles;
  var init_panel_tab_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/panels/panel-tab.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      panelTabStyles = (context, definition) => css`
	${display("inline-flex")} :host {
		box-sizing: border-box;
		font-family: ${fontFamily};
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		height: calc(${designUnit} * 7px);
		padding: calc(${designUnit} * 1px) 0;
		color: ${panelTabForeground};
		fill: currentcolor;
		border-radius: calc(${cornerRadius} * 1px);
		border: solid calc(${borderWidth} * 1px) transparent;
		align-items: center;
		justify-content: center;
		grid-row: 1;
		cursor: pointer;
	}
	:host(:hover) {
		color: ${panelTabActiveForeground};
		fill: currentcolor;
	}
	:host(:active) {
		color: ${panelTabActiveForeground};
		fill: currentcolor;
	}
	:host([aria-selected='true']) {
		background: transparent;
		color: ${panelTabActiveForeground};
		fill: currentcolor;
	}
	:host([aria-selected='true']:hover) {
		background: transparent;
		color: ${panelTabActiveForeground};
		fill: currentcolor;
	}
	:host([aria-selected='true']:active) {
		background: transparent;
		color: ${panelTabActiveForeground};
		fill: currentcolor;
	}
	:host(:${focusVisible}) {
		outline: none;
		border: solid calc(${borderWidth} * 1px) ${panelTabActiveBorder};
	}
	:host(:focus) {
		outline: none;
	}
	::slotted(vscode-badge) {
		margin-inline-start: calc(${designUnit} * 2px);
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/panels/panel-view.styles.js
  var panelViewStyles;
  var init_panel_view_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/panels/panel-view.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      panelViewStyles = (context, definition) => css`
	${display("flex")} :host {
		color: inherit;
		background-color: transparent;
		border: solid calc(${borderWidth} * 1px) transparent;
		box-sizing: border-box;
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		padding: 10px calc((${designUnit} + 2) * 1px);
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/panels/index.js
  var Panels, vsCodePanels, PanelTab, vsCodePanelTab, PanelView, vsCodePanelView;
  var init_panels = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/panels/index.js"() {
      init_esm2();
      init_panels_styles();
      init_panel_tab_styles();
      init_panel_view_styles();
      Panels = class extends Tabs {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.orientation) {
            this.orientation = TabsOrientation.horizontal;
          }
          const ariaLabelValue = this.getAttribute("aria-label");
          if (!ariaLabelValue) {
            this.setAttribute("aria-label", "Panels");
          }
        }
      };
      vsCodePanels = Panels.compose({
        baseName: "panels",
        template: tabsTemplate,
        styles: panelsStyles
      });
      PanelTab = class extends Tab {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.disabled) {
            this.disabled = false;
          }
          if (this.textContent) {
            this.setAttribute("aria-label", this.textContent);
          }
        }
      };
      vsCodePanelTab = PanelTab.compose({
        baseName: "panel-tab",
        template: tabTemplate,
        styles: panelTabStyles
      });
      PanelView = class extends TabPanel {
      };
      vsCodePanelView = PanelView.compose({
        baseName: "panel-view",
        template: tabPanelTemplate,
        styles: panelViewStyles
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/progress-ring/progress-ring.styles.js
  var progressRingStyles;
  var init_progress_ring_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/progress-ring/progress-ring.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      progressRingStyles = (context, definition) => css`
	${display("flex")} :host {
		align-items: center;
		outline: none;
		height: calc(${designUnit} * 7px);
		width: calc(${designUnit} * 7px);
		margin: 0;
	}
	.progress {
		height: 100%;
		width: 100%;
	}
	.background {
		fill: none;
		stroke: transparent;
		stroke-width: calc(${designUnit} / 2 * 1px);
	}
	.indeterminate-indicator-1 {
		fill: none;
		stroke: ${progressBackground};
		stroke-width: calc(${designUnit} / 2 * 1px);
		stroke-linecap: square;
		transform-origin: 50% 50%;
		transform: rotate(-90deg);
		transition: all 0.2s ease-in-out;
		animation: spin-infinite 2s linear infinite;
	}
	@keyframes spin-infinite {
		0% {
			stroke-dasharray: 0.01px 43.97px;
			transform: rotate(0deg);
		}
		50% {
			stroke-dasharray: 21.99px 21.99px;
			transform: rotate(450deg);
		}
		100% {
			stroke-dasharray: 0.01px 43.97px;
			transform: rotate(1080deg);
		}
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/progress-ring/index.js
  var ProgressRing, vsCodeProgressRing;
  var init_progress_ring2 = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/progress-ring/index.js"() {
      init_esm2();
      init_progress_ring_styles();
      ProgressRing = class extends BaseProgress {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.paused) {
            this.paused = false;
          }
          this.setAttribute("aria-label", "Loading");
          this.setAttribute("aria-live", "assertive");
          this.setAttribute("role", "alert");
        }
        /**
         * Component lifecycle method that runs when an attribute of the
         * element is changed.
         *
         * @param attrName - The attribute that was changed
         * @param oldVal - The old value of the attribute
         * @param newVal - The new value of the attribute
         *
         * @internal
         */
        attributeChangedCallback(attrName, oldVal, newVal) {
          if (attrName === "value") {
            this.removeAttribute("value");
          }
        }
      };
      vsCodeProgressRing = ProgressRing.compose({
        baseName: "progress-ring",
        template: progressRingTemplate,
        styles: progressRingStyles,
        indeterminateIndicator: `
		<svg class="progress" part="progress" viewBox="0 0 16 16">
			<circle
				class="background"
				part="background"
				cx="8px"
				cy="8px"
				r="7px"
			></circle>
			<circle
				class="indeterminate-indicator-1"
				part="indeterminate-indicator-1"
				cx="8px"
				cy="8px"
				r="7px"
			></circle>
		</svg>
	`
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/radio-group/radio-group.styles.js
  var radioGroupStyles;
  var init_radio_group_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/radio-group/radio-group.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      radioGroupStyles = (context, definition) => css`
	${display("flex")} :host {
		align-items: flex-start;
		margin: calc(${designUnit} * 1px) 0;
		flex-direction: column;
	}
	.positioning-region {
		display: flex;
		flex-wrap: wrap;
	}
	:host([orientation='vertical']) .positioning-region {
		flex-direction: column;
	}
	:host([orientation='horizontal']) .positioning-region {
		flex-direction: row;
	}
	::slotted([slot='label']) {
		color: ${foreground};
		font-size: ${typeRampBaseFontSize};
		margin: calc(${designUnit} * 1px) 0;
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/radio-group/index.js
  var RadioGroup2, vsCodeRadioGroup;
  var init_radio_group3 = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/radio-group/index.js"() {
      init_dist2();
      init_esm2();
      init_radio_group_styles();
      RadioGroup2 = class extends RadioGroup {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          const label = this.querySelector("label");
          if (label) {
            const id = "radio-group-" + Math.random().toString(16).slice(2);
            label.setAttribute("id", id);
            this.setAttribute("aria-labelledby", id);
          }
        }
      };
      vsCodeRadioGroup = RadioGroup2.compose({
        baseName: "radio-group",
        template: radioGroupTemplate,
        styles: radioGroupStyles
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/radio/radio.styles.js
  var radioStyles;
  var init_radio_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/radio/radio.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      radioStyles = (context, definition) => css`
	${display("inline-flex")} :host {
		align-items: center;
		flex-direction: row;
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		margin: calc(${designUnit} * 1px) 0;
		outline: none;
		position: relative;
		transition: all 0.2s ease-in-out;
		user-select: none;
	}
	.control {
		background: ${checkboxBackground};
		border-radius: 999px;
		border: calc(${borderWidth} * 1px) solid ${checkboxBorder};
		box-sizing: border-box;
		cursor: pointer;
		height: calc(${designUnit} * 4px);
		position: relative;
		outline: none;
		width: calc(${designUnit} * 4px);
	}
	.label {
		color: ${foreground};
		cursor: pointer;
		font-family: ${fontFamily};
		margin-inline-end: calc(${designUnit} * 2px + 2px);
		padding-inline-start: calc(${designUnit} * 2px + 2px);
	}
	.label__hidden {
		display: none;
		visibility: hidden;
	}
	.control,
	.checked-indicator {
		flex-shrink: 0;
	}
	.checked-indicator {
		background: ${foreground};
		border-radius: 999px;
		display: inline-block;
		inset: calc(${designUnit} * 1px);
		opacity: 0;
		pointer-events: none;
		position: absolute;
	}
	:host(:not([disabled])) .control:hover {
		background: ${checkboxBackground};
		border-color: ${checkboxBorder};
	}
	:host(:not([disabled])) .control:active {
		background: ${checkboxBackground};
		border-color: ${focusBorder};
	}
	:host(:${focusVisible}) .control {
		border: calc(${borderWidth} * 1px) solid ${focusBorder};
	}
	:host([aria-checked='true']) .control {
		background: ${checkboxBackground};
		border: calc(${borderWidth} * 1px) solid ${checkboxBorder};
	}
	:host([aria-checked='true']:not([disabled])) .control:hover {
		background: ${checkboxBackground};
		border: calc(${borderWidth} * 1px) solid ${checkboxBorder};
	}
	:host([aria-checked='true']:not([disabled])) .control:active {
		background: ${checkboxBackground};
		border: calc(${borderWidth} * 1px) solid ${focusBorder};
	}
	:host([aria-checked="true"]:${focusVisible}:not([disabled])) .control {
		border: calc(${borderWidth} * 1px) solid ${focusBorder};
	}
	:host([disabled]) .label,
	:host([readonly]) .label,
	:host([readonly]) .control,
	:host([disabled]) .control {
		cursor: ${disabledCursor};
	}
	:host([aria-checked='true']) .checked-indicator {
		opacity: 1;
	}
	:host([disabled]) {
		opacity: ${disabledOpacity};
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/radio/index.js
  var Radio2, vsCodeRadio;
  var init_radio3 = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/radio/index.js"() {
      init_esm2();
      init_radio_styles();
      Radio2 = class extends Radio {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.textContent) {
            this.setAttribute("aria-label", this.textContent);
          } else {
            this.setAttribute("aria-label", "Radio");
          }
        }
      };
      vsCodeRadio = Radio2.compose({
        baseName: "radio",
        template: radioTemplate,
        styles: radioStyles,
        checkedIndicator: `
		<div part="checked-indicator" class="checked-indicator"></div>
	`
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/tag/tag.styles.js
  var tagStyles;
  var init_tag_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/tag/tag.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      tagStyles = (context, definition) => css`
	${display("inline-block")} :host {
		box-sizing: border-box;
		font-family: ${fontFamily};
		font-size: ${typeRampMinus1FontSize};
		line-height: ${typeRampMinus1LineHeight};
	}
	.control {
		background-color: ${badgeBackground};
		border: calc(${borderWidth} * 1px) solid ${buttonBorder};
		border-radius: ${tagCornerRadius};
		color: ${badgeForeground};
		padding: calc(${designUnit} * 0.5px) calc(${designUnit} * 1px);
		text-transform: uppercase;
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/tag/index.js
  var Tag, vsCodeTag;
  var init_tag = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/tag/index.js"() {
      init_esm2();
      init_tag_styles();
      Tag = class extends Badge {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.circular) {
            this.circular = false;
          }
        }
      };
      vsCodeTag = Tag.compose({
        baseName: "tag",
        template: badgeTemplate,
        styles: tagStyles
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/text-area/text-area.styles.js
  var textAreaStyles;
  var init_text_area_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/text-area/text-area.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      textAreaStyles = (context, definition) => css`
	${display("inline-block")} :host {
		font-family: ${fontFamily};
		outline: none;
		user-select: none;
	}
	.control {
		box-sizing: border-box;
		position: relative;
		color: ${inputForeground};
		background: ${inputBackground};
		border-radius: calc(${cornerRadiusRound} * 1px);
		border: calc(${borderWidth} * 1px) solid ${dropdownBorder};
		font: inherit;
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		padding: calc(${designUnit} * 2px + 1px);
		width: 100%;
		min-width: ${inputMinWidth};
		resize: none;
	}
	.control:hover:enabled {
		background: ${inputBackground};
		border-color: ${dropdownBorder};
	}
	.control:active:enabled {
		background: ${inputBackground};
		border-color: ${focusBorder};
	}
	.control:hover,
	.control:${focusVisible},
	.control:disabled,
	.control:active {
		outline: none;
	}
	.control::-webkit-scrollbar {
		width: ${scrollbarWidth};
		height: ${scrollbarHeight};
	}
	.control::-webkit-scrollbar-corner {
		background: ${inputBackground};
	}
	.control::-webkit-scrollbar-thumb {
		background: ${scrollbarSliderBackground};
	}
	.control::-webkit-scrollbar-thumb:hover {
		background: ${scrollbarSliderHoverBackground};
	}
	.control::-webkit-scrollbar-thumb:active {
		background: ${scrollbarSliderActiveBackground};
	}
	:host(:focus-within:not([disabled])) .control {
		border-color: ${focusBorder};
	}
	:host([resize='both']) .control {
		resize: both;
	}
	:host([resize='horizontal']) .control {
		resize: horizontal;
	}
	:host([resize='vertical']) .control {
		resize: vertical;
	}
	.label {
		display: block;
		color: ${foreground};
		cursor: pointer;
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		margin-bottom: 2px;
	}
	.label__hidden {
		display: none;
		visibility: hidden;
	}
	:host([disabled]) .label,
	:host([readonly]) .label,
	:host([readonly]) .control,
	:host([disabled]) .control {
		cursor: ${disabledCursor};
	}
	:host([disabled]) {
		opacity: ${disabledOpacity};
	}
	:host([disabled]) .control {
		border-color: ${dropdownBorder};
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/text-area/index.js
  var TextArea2, vsCodeTextArea;
  var init_text_area3 = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/text-area/index.js"() {
      init_esm2();
      init_text_area_styles();
      TextArea2 = class extends TextArea {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.textContent) {
            this.setAttribute("aria-label", this.textContent);
          } else {
            this.setAttribute("aria-label", "Text area");
          }
        }
      };
      vsCodeTextArea = TextArea2.compose({
        baseName: "text-area",
        template: textAreaTemplate,
        styles: textAreaStyles,
        shadowOptions: {
          delegatesFocus: true
        }
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/text-field/text-field.styles.js
  var textFieldStyles;
  var init_text_field_styles = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/text-field/text-field.styles.js"() {
      init_esm();
      init_esm2();
      init_design_tokens();
      textFieldStyles = (context, definition) => css`
	${display("inline-block")} :host {
		font-family: ${fontFamily};
		outline: none;
		user-select: none;
	}
	.root {
		box-sizing: border-box;
		position: relative;
		display: flex;
		flex-direction: row;
		color: ${inputForeground};
		background: ${inputBackground};
		border-radius: calc(${cornerRadiusRound} * 1px);
		border: calc(${borderWidth} * 1px) solid ${dropdownBorder};
		height: calc(${inputHeight} * 1px);
		min-width: ${inputMinWidth};
	}
	.control {
		-webkit-appearance: none;
		font: inherit;
		background: transparent;
		border: 0;
		color: inherit;
		height: calc(100% - (${designUnit} * 1px));
		width: 100%;
		margin-top: auto;
		margin-bottom: auto;
		border: none;
		padding: 0 calc(${designUnit} * 2px + 1px);
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
	}
	.control:hover,
	.control:${focusVisible},
	.control:disabled,
	.control:active {
		outline: none;
	}
	.label {
		display: block;
		color: ${foreground};
		cursor: pointer;
		font-size: ${typeRampBaseFontSize};
		line-height: ${typeRampBaseLineHeight};
		margin-bottom: 2px;
	}
	.label__hidden {
		display: none;
		visibility: hidden;
	}
	.start,
	.end {
		display: flex;
		margin: auto;
		fill: currentcolor;
	}
	::slotted(svg),
	::slotted(span) {
		width: calc(${designUnit} * 4px);
		height: calc(${designUnit} * 4px);
	}
	.start {
		margin-inline-start: calc(${designUnit} * 2px);
	}
	.end {
		margin-inline-end: calc(${designUnit} * 2px);
	}
	:host(:hover:not([disabled])) .root {
		background: ${inputBackground};
		border-color: ${dropdownBorder};
	}
	:host(:active:not([disabled])) .root {
		background: ${inputBackground};
		border-color: ${focusBorder};
	}
	:host(:focus-within:not([disabled])) .root {
		border-color: ${focusBorder};
	}
	:host([disabled]) .label,
	:host([readonly]) .label,
	:host([readonly]) .control,
	:host([disabled]) .control {
		cursor: ${disabledCursor};
	}
	:host([disabled]) {
		opacity: ${disabledOpacity};
	}
	:host([disabled]) .control {
		border-color: ${dropdownBorder};
	}
`;
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/text-field/index.js
  var TextField2, vsCodeTextField;
  var init_text_field3 = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/text-field/index.js"() {
      init_esm2();
      init_text_field_styles();
      TextField2 = class extends TextField {
        /**
         * Component lifecycle method that runs when the component is inserted
         * into the DOM.
         *
         * @internal
         */
        connectedCallback() {
          super.connectedCallback();
          if (this.textContent) {
            this.setAttribute("aria-label", this.textContent);
          } else {
            this.setAttribute("aria-label", "Text field");
          }
        }
      };
      vsCodeTextField = TextField2.compose({
        baseName: "text-field",
        template: textFieldTemplate,
        styles: textFieldStyles,
        shadowOptions: {
          delegatesFocus: true
        }
      });
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/custom-elements.js
  var allComponents;
  var init_custom_elements = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/custom-elements.js"() {
      init_badge3();
      init_button3();
      init_checkbox3();
      init_data_grid3();
      init_divider3();
      init_dropdown();
      init_link();
      init_option();
      init_panels();
      init_progress_ring2();
      init_radio_group3();
      init_radio3();
      init_tag();
      init_text_area3();
      init_text_field3();
      allComponents = {
        vsCodeBadge,
        vsCodeButton,
        vsCodeCheckbox,
        vsCodeDataGrid,
        vsCodeDataGridCell,
        vsCodeDataGridRow,
        vsCodeDivider,
        vsCodeDropdown,
        vsCodeLink,
        vsCodeOption,
        vsCodePanels,
        vsCodePanelTab,
        vsCodePanelView,
        vsCodeProgressRing,
        vsCodeRadioGroup,
        vsCodeRadio,
        vsCodeTag,
        vsCodeTextArea,
        vsCodeTextField,
        register(container, ...rest) {
          if (!container) {
            return;
          }
          for (const key in this) {
            if (key === "register") {
              continue;
            }
            this[key]().register(container, ...rest);
          }
        }
      };
    }
  });

  // node_modules/@vscode/webview-ui-toolkit/dist/index.js
  var dist_exports = {};
  __export(dist_exports, {
    Badge: () => Badge2,
    Button: () => Button2,
    Checkbox: () => Checkbox2,
    DataGrid: () => DataGrid2,
    DataGridCell: () => DataGridCell2,
    DataGridCellTypes: () => DataGridCellTypes,
    DataGridRow: () => DataGridRow2,
    DataGridRowTypes: () => DataGridRowTypes,
    Divider: () => Divider2,
    DividerRole: () => DividerRole,
    Dropdown: () => Dropdown,
    DropdownPosition: () => SelectPosition,
    GenerateHeaderOptions: () => GenerateHeaderOptions,
    Link: () => Link,
    Option: () => Option2,
    PanelTab: () => PanelTab,
    PanelView: () => PanelView,
    Panels: () => Panels,
    ProgressRing: () => ProgressRing,
    Radio: () => Radio2,
    RadioGroup: () => RadioGroup2,
    RadioGroupOrientation: () => Orientation,
    Tag: () => Tag,
    TextArea: () => TextArea2,
    TextAreaResize: () => TextAreaResize,
    TextField: () => TextField2,
    TextFieldType: () => TextFieldType,
    allComponents: () => allComponents,
    provideVSCodeDesignSystem: () => provideVSCodeDesignSystem,
    vsCodeBadge: () => vsCodeBadge,
    vsCodeButton: () => vsCodeButton,
    vsCodeCheckbox: () => vsCodeCheckbox,
    vsCodeDataGrid: () => vsCodeDataGrid,
    vsCodeDataGridCell: () => vsCodeDataGridCell,
    vsCodeDataGridRow: () => vsCodeDataGridRow,
    vsCodeDivider: () => vsCodeDivider,
    vsCodeDropdown: () => vsCodeDropdown,
    vsCodeLink: () => vsCodeLink,
    vsCodeOption: () => vsCodeOption,
    vsCodePanelTab: () => vsCodePanelTab,
    vsCodePanelView: () => vsCodePanelView,
    vsCodePanels: () => vsCodePanels,
    vsCodeProgressRing: () => vsCodeProgressRing,
    vsCodeRadio: () => vsCodeRadio,
    vsCodeRadioGroup: () => vsCodeRadioGroup,
    vsCodeTag: () => vsCodeTag,
    vsCodeTextArea: () => vsCodeTextArea,
    vsCodeTextField: () => vsCodeTextField
  });
  var init_dist3 = __esm({
    "node_modules/@vscode/webview-ui-toolkit/dist/index.js"() {
      init_vscode_design_system();
      init_custom_elements();
      init_badge3();
      init_button3();
      init_checkbox3();
      init_data_grid3();
      init_divider3();
      init_dropdown();
      init_link();
      init_option();
      init_panels();
      init_progress_ring2();
      init_radio_group3();
      init_radio3();
      init_tag();
      init_text_area3();
      init_text_field3();
    }
  });

  // src/webview/shared/buttonConfig.ts
  var BUTTONS = {
    "btn-refresh": {
      id: "btn-refresh",
      label: "\u{1F504} Refresh",
      appearance: "primary"
    },
    "btn-details": {
      id: "btn-details",
      label: "\u{1F916} Details"
    },
    "btn-chart": {
      id: "btn-chart",
      label: "\u{1F4C8} Chart"
    },
    "btn-usage": {
      id: "btn-usage",
      label: "\u{1F4CA} Usage Analysis"
    },
    "btn-diagnostics": {
      id: "btn-diagnostics",
      label: "\u{1F50D} Diagnostics"
    },
    "btn-maturity": {
      id: "btn-maturity",
      label: "\u{1F3AF} Fluency Score"
    },
    "btn-dashboard": {
      id: "btn-dashboard",
      label: "\u{1F4CA} Team Dashboard"
    },
    "btn-level-viewer": {
      id: "btn-level-viewer",
      label: "\u{1F50D} Level Viewer"
    },
    "btn-environmental": {
      id: "btn-environmental",
      label: "\u{1F33F} Environmental Impact"
    }
  };
  function buttonHtml(id) {
    const config = BUTTONS[id];
    const appearance = config.appearance ? ` appearance="${config.appearance}"` : "";
    return `<vscode-button id="${config.id}"${appearance}>${config.label}</vscode-button>`;
  }

  // src/webview/shared/theme.css
  var theme_default = '/**\n * Shared theme variables for all webview panels\n * Uses VS Code theme tokens for automatic light/dark theme support\n */\n\n:root {\n	/* VS Code base colors */\n	--bg-primary: var(--vscode-editor-background);\n	--bg-secondary: var(--vscode-sideBar-background);\n	--bg-tertiary: var(--vscode-editorWidget-background);\n	--text-primary: var(--vscode-editor-foreground);\n	--text-secondary: var(--vscode-descriptionForeground);\n	--text-muted: var(--vscode-disabledForeground);\n	--border-color: var(--vscode-panel-border);\n	--border-subtle: var(--vscode-widget-border);\n	\n	/* Button colors */\n	--button-bg: var(--vscode-button-background);\n	--button-fg: var(--vscode-button-foreground);\n	--button-hover-bg: var(--vscode-button-hoverBackground);\n	--button-secondary-bg: var(--vscode-button-secondaryBackground);\n	--button-secondary-fg: var(--vscode-button-secondaryForeground);\n	--button-secondary-hover-bg: var(--vscode-button-secondaryHoverBackground);\n	\n	/* Input colors */\n	--input-bg: var(--vscode-input-background);\n	--input-fg: var(--vscode-input-foreground);\n	--input-border: var(--vscode-input-border);\n	\n	/* List/card colors */\n	--list-hover-bg: var(--vscode-list-hoverBackground);\n	--list-active-bg: var(--vscode-list-activeSelectionBackground);\n	--list-active-fg: var(--vscode-list-activeSelectionForeground);\n	--list-inactive-bg: var(--vscode-list-inactiveSelectionBackground);\n	\n	/* Alternating row colors for better readability */\n	--row-alternate-bg: var(--vscode-list-inactiveSelectionBackground);\n	\n	/* Badge colors */\n	--badge-bg: var(--vscode-badge-background);\n	--badge-fg: var(--vscode-badge-foreground);\n	\n	/* Focus colors */\n	--focus-border: var(--vscode-focusBorder);\n	\n	/* Link colors */\n	--link-color: var(--vscode-textLink-foreground);\n	--link-hover-color: var(--vscode-textLink-activeForeground);\n	\n	/* Status colors */\n	--error-fg: var(--vscode-errorForeground);\n	--warning-fg: var(--vscode-editorWarning-foreground);\n	--success-fg: var(--vscode-terminal-ansiGreen);\n	\n	/* Shadow for cards */\n	--shadow-color: rgb(0, 0, 0, 0.16);\n	--shadow-hover-color: rgb(0, 0, 0, 0.24);\n}\n\n/* Light theme adjustments */\nbody[data-vscode-theme-kind="vscode-light"],\nbody[data-vscode-theme-kind="vscode-high-contrast-light"] {\n	--shadow-color: rgb(0, 0, 0, 0.08);\n	--shadow-hover-color: rgb(0, 0, 0, 0.12);\n}\n\n/* High contrast mode adjustments */\nbody[data-vscode-theme-kind="vscode-high-contrast"],\nbody[data-vscode-theme-kind="vscode-high-contrast-light"] {\n	--border-color: var(--vscode-contrastBorder);\n	--border-subtle: var(--vscode-contrastBorder);\n}\n';

  // src/webview/diagnostics/styles.css
  var styles_default = "* {\n	margin: 0;\n	padding: 0;\n	box-sizing: border-box;\n}\n\nbody {\n	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n	background: var(--bg-primary);\n	color: var(--text-primary);\n	padding: 16px;\n	line-height: 1.5;\n	min-width: 320px;\n}\n\n.container {\n	background: var(--bg-secondary);\n	border: 1px solid var(--border-color);\n	border-radius: 10px;\n	padding: 16px;\n	box-shadow: 0 4px 10px var(--shadow-color);\n	max-width: 1200px;\n	margin: 0 auto;\n}\n\n.header {\n	display: flex;\n	justify-content: space-between;\n	align-items: center;\n	gap: 12px;\n	margin-bottom: 16px;\n	padding-bottom: 4px;\n}\n\n.header-left {\n	display: flex;\n	align-items: center;\n	gap: 8px;\n}\n\n.header-icon {\n	font-size: 20px;\n}\n\n\n.button-row {\n	display: flex;\n	flex-wrap: wrap;\n	gap: 8px;\n}\n\n.section {\n	background: var(--bg-tertiary);\n	border: 1px solid var(--border-color);\n	border-radius: 8px;\n	padding: 12px;\n	margin-bottom: 16px;\n	box-shadow: 0 2px 6px var(--shadow-color);\n}\n\n.section-title {\n	font-size: 14px;\n	font-weight: 700;\n	color: var(--text-primary);\n	margin-bottom: 10px;\n	display: flex;\n	align-items: center;\n	gap: 6px;\n	letter-spacing: 0.2px;\n}\n\n.section-subtitle {\n	font-size: 12px;\n	color: var(--text-secondary);\n	margin-bottom: 12px;\n}\n\n/* Tab styles */\n.tabs {\n	display: flex;\n	border-bottom: 1px solid var(--border-color);\n	margin-bottom: 16px;\n}\n\n.tab {\n	padding: 10px 20px;\n	cursor: pointer;\n	border: none;\n	background: transparent;\n	color: var(--text-secondary);\n	font-size: 13px;\n	font-weight: 500;\n	border-bottom: 2px solid transparent;\n	transition: all 0.2s;\n}\n\n.tab:hover {\n	color: var(--text-primary);\n	background: var(--list-hover-bg);\n}\n\n.tab.active {\n	color: var(--link-color);\n	border-bottom-color: var(--link-color);\n}\n\n.tab-content {\n	display: none;\n}\n\n.tab-content.active {\n	display: block;\n}\n\n/* Editor filter panels */\n.editor-filter-panels {\n	display: flex;\n	flex-wrap: wrap;\n	gap: 10px;\n	margin-bottom: 16px;\n}\n\n.editor-panel {\n	background: var(--bg-tertiary);\n	border: 2px solid var(--border-color);\n	border-radius: 8px;\n	padding: 12px 16px;\n	cursor: pointer;\n	transition: all 0.2s;\n	min-width: 140px;\n	text-align: center;\n	white-space: nowrap;\n}\n\n.editor-panel:hover {\n	background: var(--list-hover-bg);\n	border-color: var(--border-color);\n}\n\n.editor-panel.active {\n	background: var(--list-active-bg);\n	border-color: var(--link-color);\n	color: var(--list-active-fg);\n}\n\n.editor-panel.active .editor-panel-name {\n	color: var(--list-active-fg);\n}\n\n.editor-panel.active .editor-panel-stats {\n	color: var(--list-active-fg);\n	opacity: 0.85;\n}\n\n.editor-panel-icon {\n	font-size: 24px;\n	margin-bottom: 4px;\n}\n\n.editor-panel-name {\n	font-size: 13px;\n	font-weight: 600;\n	color: var(--text-primary);\n	margin-bottom: 2px;\n}\n\n.editor-panel-stats {\n	font-size: 10px;\n	color: var(--text-muted);\n}\n\n/* Loading state */\n.loading-state {\n	text-align: center;\n	padding: 40px 20px;\n	color: var(--text-muted);\n}\n\n.loading-spinner {\n	font-size: 48px;\n	margin-bottom: 16px;\n	animation: pulse 1.5s ease-in-out infinite;\n}\n\n@keyframes pulse {\n	0%,\n	100% {\n		opacity: 1;\n	}\n\n	50% {\n		opacity: 0.5;\n	}\n}\n\n.loading-text {\n	font-size: 16px;\n	color: var(--text-primary);\n	margin-bottom: 8px;\n}\n\n.loading-subtext {\n	font-size: 12px;\n	color: var(--text-muted);\n}\n\n/* Summary cards */\n.summary-cards {\n	display: grid;\n	grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));\n	gap: 12px;\n	margin-bottom: 16px;\n}\n\n.summary-card {\n	background: var(--bg-tertiary);\n	border: 1px solid var(--border-color);\n	border-radius: 4px;\n	padding: 12px;\n	text-align: center;\n}\n\n.summary-label {\n	font-size: 11px;\n	color: var(--text-secondary);\n	margin-bottom: 4px;\n}\n\n.summary-value {\n	font-size: 18px;\n	font-weight: 600;\n	color: var(--text-primary);\n}\n\n.summary-sub {\n	font-size: 10px;\n	color: var(--text-secondary);\n	text-align: left;\n	margin-top: 6px;\n}\n\n.context-ref-filter {\n	cursor: pointer;\n	padding: 2px 6px;\n	border-radius: 3px;\n	margin: 2px 0;\n	transition: all 0.2s;\n}\n\n.context-ref-filter:hover {\n	background: rgb(79, 195, 247, 0.2);\n	color: var(--link-color);\n}\n\n.context-ref-filter.active {\n	background: rgb(79, 195, 247, 0.3);\n	color: var(--link-color);\n	font-weight: 600;\n}\n\n/* Table styles */\n.table-container {\n	overflow: auto;\n	max-height: 500px;\n}\n\n.session-table {\n	width: 100%;\n	border-collapse: collapse;\n	font-size: 12px;\n}\n\n.session-table th,\n.session-table td {\n	padding: 8px 10px;\n	text-align: left;\n	border-bottom: 1px solid var(--border-color);\n}\n\n.session-table th {\n	background: var(--bg-tertiary);\n	color: var(--text-primary);\n	font-weight: 600;\n	position: sticky;\n	top: 0;\n}\n\n.session-table th.sortable {\n	cursor: pointer;\n	user-select: none;\n}\n\n.session-table th.sortable:hover {\n	background: var(--list-hover-bg);\n	color: var(--link-color);\n}\n\n.session-table tr:hover {\n	background: rgb(255, 255, 255, 0.03);\n}\n\n.editor-badge {\n	background: var(--list-active-bg);\n	padding: 2px 6px;\n	border-radius: 3px;\n	font-size: 10px;\n	color: var(--list-active-fg);\n	white-space: nowrap;\n}\n\n.editor-badge-crush {\n	background: #3d0a4f;\n	color: #ff3dff;\n	border: 1px solid #cc00cc;\n}\n\n.editor-badge-vs {\n	background: #5c2d91;\n	color: #ffffff;\n	border: 1px solid #7b3fbe;\n}\n\n.session-folders-table {\n	margin-top: 16px;\n	margin-bottom: 16px;\n}\n\n.session-folders-table h4 {\n	color: var(--text-primary);\n	font-size: 14px;\n	margin-bottom: 12px;\n}\n\n.report-content {\n	background: var(--bg-tertiary);\n	border: 1px solid var(--border-color);\n	border-radius: 4px;\n	padding: 16px;\n	white-space: pre-wrap;\n	font-size: 13px;\n	overflow: auto;\n	max-height: 60vh;\n}\n\n.file-subpath {\n	font-size: 11px;\n	color: var(--text-muted);\n	margin-top: 4px;\n}\n\n.session-file-link,\n.reveal-link,\n.view-formatted-link {\n	color: var(--link-color);\n	text-decoration: underline;\n	cursor: pointer;\n}\n\n.session-file-link:hover,\n.reveal-link:hover,\n.view-formatted-link:hover {\n	color: var(--link-hover-color);\n}\n\n.empty-session-link {\n	color: var(--text-muted);\n}\n\n.empty-session-link:hover {\n	color: var(--text-secondary);\n}\n\n.button-group {\n	display: flex;\n	gap: 12px;\n	margin-top: 16px;\n	flex-wrap: wrap;\n}\n\n.button {\n	background: var(--button-secondary-bg);\n	border: 1px solid var(--border-subtle);\n	color: var(--text-primary);\n	padding: 8px 12px;\n	border-radius: 6px;\n	cursor: pointer;\n	font-size: 13px;\n	font-weight: 500;\n	transition: background-color 0.15s ease;\n	display: inline-flex;\n	align-items: center;\n	gap: 8px;\n}\n\n.button:hover {\n	background: var(--bg-tertiary);\n}\n\n.button:active {\n	background: var(--button-bg);\n}\n\n.button:disabled {\n	opacity: 0.6;\n	cursor: not-allowed;\n}\n\n.button.secondary {\n	background: var(--bg-tertiary);\n	border-color: var(--border-subtle);\n	color: var(--text-primary);\n}\n\n.button.secondary:hover {\n	background: var(--list-hover-bg);\n}\n\n.info-box {\n	background: var(--list-active-bg);\n	border: 1px solid var(--border-color);\n	border-radius: 4px;\n	padding: 12px;\n	margin-bottom: 16px;\n	font-size: 13px;\n	color: var(--list-active-fg);\n}\n\n.info-box-title {\n	font-weight: 600;\n	color: var(--list-active-fg);\n	margin-bottom: 6px;\n}\n\n.cache-details {\n	margin-top: 16px;\n}\n\n.cache-location {\n	margin-top: 20px;\n}\n\n.cache-location h4 {\n	color: var(--text-primary);\n	font-size: 14px;\n	margin-bottom: 8px;\n}\n\n.location-box {\n	background: var(--bg-tertiary);\n	border: 1px solid var(--border-color);\n	border-radius: 4px;\n	padding: 12px;\n	overflow-x: auto;\n}\n\n.location-box code {\n	color: var(--link-color);\n	font-size: 12px;\n}\n\n.cache-actions {\n	margin-top: 20px;\n}\n\n.cache-actions h4 {\n	color: var(--text-primary);\n	font-size: 14px;\n	margin-bottom: 8px;\n}\n";

  // src/webview/shared/contextRefUtils.ts
  function getTotalContextRefs(refs) {
    return refs.file + refs.selection + refs.implicitSelection + refs.symbol + refs.codebase + refs.workspace + refs.terminal + refs.vscode + refs.copilotInstructions + refs.agentsMd + (refs.terminalLastCommand || 0) + (refs.terminalSelection || 0) + (refs.clipboard || 0) + (refs.changes || 0) + (refs.outputPanel || 0) + (refs.problemsPanel || 0);
  }
  function getContextRefsSummary(refs, abbreviated = false) {
    const parts = [];
    if (abbreviated) {
      if (refs.file > 0) {
        parts.push(`#file: ${refs.file}`);
      }
      if (refs.selection > 0) {
        parts.push(`#sel: ${refs.selection}`);
      }
      if (refs.implicitSelection > 0) {
        parts.push(`impl: ${refs.implicitSelection}`);
      }
      if (refs.symbol > 0) {
        parts.push(`#sym: ${refs.symbol}`);
      }
      if (refs.codebase > 0) {
        parts.push(`#cb: ${refs.codebase}`);
      }
      if (refs.workspace > 0) {
        parts.push(`@ws: ${refs.workspace}`);
      }
      if (refs.terminal > 0) {
        parts.push(`@term: ${refs.terminal}`);
      }
      if (refs.vscode > 0) {
        parts.push(`@vsc: ${refs.vscode}`);
      }
      if ((refs.terminalLastCommand || 0) > 0) {
        parts.push(`#termLC: ${refs.terminalLastCommand}`);
      }
      if ((refs.terminalSelection || 0) > 0) {
        parts.push(`#termSel: ${refs.terminalSelection}`);
      }
      if ((refs.clipboard || 0) > 0) {
        parts.push(`#clip: ${refs.clipboard}`);
      }
      if ((refs.changes || 0) > 0) {
        parts.push(`#chg: ${refs.changes}`);
      }
      if ((refs.outputPanel || 0) > 0) {
        parts.push(`#out: ${refs.outputPanel}`);
      }
      if ((refs.problemsPanel || 0) > 0) {
        parts.push(`#prob: ${refs.problemsPanel}`);
      }
      if (refs.copilotInstructions > 0) {
        parts.push(`\u{1F4CB} inst: ${refs.copilotInstructions}`);
      }
      if (refs.agentsMd > 0) {
        parts.push(`\u{1F916} ag: ${refs.agentsMd}`);
      }
    } else {
      if (refs.file > 0) {
        parts.push(`#file: ${refs.file}`);
      }
      if (refs.selection > 0) {
        parts.push(`#selection: ${refs.selection}`);
      }
      if (refs.implicitSelection > 0) {
        parts.push(`implicit: ${refs.implicitSelection}`);
      }
      if (refs.symbol > 0) {
        parts.push(`#symbol: ${refs.symbol}`);
      }
      if (refs.codebase > 0) {
        parts.push(`#codebase: ${refs.codebase}`);
      }
      if (refs.workspace > 0) {
        parts.push(`@workspace: ${refs.workspace}`);
      }
      if (refs.terminal > 0) {
        parts.push(`@terminal: ${refs.terminal}`);
      }
      if (refs.vscode > 0) {
        parts.push(`@vscode: ${refs.vscode}`);
      }
      if ((refs.terminalLastCommand || 0) > 0) {
        parts.push(`#terminalLastCommand: ${refs.terminalLastCommand}`);
      }
      if ((refs.terminalSelection || 0) > 0) {
        parts.push(`#terminalSelection: ${refs.terminalSelection}`);
      }
      if ((refs.clipboard || 0) > 0) {
        parts.push(`#clipboard: ${refs.clipboard}`);
      }
      if ((refs.changes || 0) > 0) {
        parts.push(`#changes: ${refs.changes}`);
      }
      if ((refs.outputPanel || 0) > 0) {
        parts.push(`#outputPanel: ${refs.outputPanel}`);
      }
      if ((refs.problemsPanel || 0) > 0) {
        parts.push(`#problemsPanel: ${refs.problemsPanel}`);
      }
      if (refs.copilotInstructions > 0) {
        parts.push(`\u{1F4CB} instructions: ${refs.copilotInstructions}`);
      }
      if (refs.agentsMd > 0) {
        parts.push(`\u{1F916} agents: ${refs.agentsMd}`);
      }
    }
    return parts.length > 0 ? parts.join(", ") : "None";
  }

  // src/webview/diagnostics/main.ts
  var LOADING_PLACEHOLDER = "Loading...";
  var SESSION_FILES_SECTION_REGEX = /Session File Locations \(first 20\):[\s\S]*?(?=\n\s*\n|={70})/;
  var LOADING_MESSAGE = `\u23F3 Loading diagnostic data...

This may take a few moments depending on the number of session files.
The view will automatically update when data is ready.`;
  var vscode = acquireVsCodeApi();
  var initialData = window.__INITIAL_DIAGNOSTICS__;
  var currentSortColumn = "lastInteraction";
  var currentSortDirection = "desc";
  var currentEditorFilter = null;
  var currentContextRefFilter = null;
  function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function removeSessionFilesSection(reportText) {
    return reportText.replace(SESSION_FILES_SECTION_REGEX, "");
  }
  function formatDate(isoString) {
    if (!isoString) {
      return "N/A";
    }
    try {
      return escapeHtml(new Date(isoString).toLocaleString());
    } catch {
      return escapeHtml(isoString);
    }
  }
  function getTimeSince(isoString) {
    try {
      const now = Date.now();
      const then = new Date(isoString).getTime();
      const diffMs = now - then;
      if (diffMs < 0) {
        return "Just now";
      }
      const seconds = Math.floor(diffMs / 1e3);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      if (days > 0) {
        return `${days} day${days !== 1 ? "s" : ""} ago`;
      }
      if (hours > 0) {
        return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
      }
      if (minutes > 0) {
        return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
      }
      return `${seconds} second${seconds !== 1 ? "s" : ""} ago`;
    } catch {
      return "Unknown";
    }
  }
  function formatFileSize(bytes) {
    const numericBytes = Number(bytes);
    if (!Number.isFinite(numericBytes) || numericBytes < 0) {
      return "N/A";
    }
    if (numericBytes < 1024) {
      return `${numericBytes} B`;
    }
    if (numericBytes < 1024 * 1024) {
      return `${(numericBytes / 1024).toFixed(1)} KB`;
    }
    return `${(numericBytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  function sanitizeNumber(value) {
    if (value === void 0 || value === null) {
      return "0";
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return "0";
    }
    return Math.floor(n).toString();
  }
  function buildCandidatePathsElement(candidatePaths) {
    const container = document.createElement("div");
    container.className = "candidate-paths-table";
    const heading = document.createElement("h4");
    heading.textContent = "Scanned Paths (all candidate locations):";
    container.appendChild(heading);
    const description = document.createElement("p");
    description.style.cssText = "color: #999; font-size: 12px; margin: 4px 0 8px 0;";
    description.textContent = "These are all the paths the extension checks for session files. Paths marked with \u2705 exist on this system.";
    container.appendChild(description);
    const table = document.createElement("table");
    table.className = "session-table";
    container.appendChild(table);
    const thead = document.createElement("thead");
    table.appendChild(thead);
    const headerRow = document.createElement("tr");
    thead.appendChild(headerRow);
    for (const text of ["Status", "Source", "Path"]) {
      const th = document.createElement("th");
      th.textContent = text;
      headerRow.appendChild(th);
    }
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    const sorted = [...candidatePaths].sort((a, b) => {
      if (a.exists !== b.exists) {
        return a.exists ? -1 : 1;
      }
      return a.source.localeCompare(b.source);
    });
    const crushEntries = sorted.filter(
      (cp) => cp.source.toLowerCase().includes("crush")
    );
    const otherEntries = sorted.filter(
      (cp) => !cp.source.toLowerCase().includes("crush")
    );
    const renderRow = (cp) => {
      const row = document.createElement("tr");
      if (!cp.exists) {
        row.style.opacity = "0.5";
      }
      const statusCell = document.createElement("td");
      statusCell.textContent = cp.exists ? "\u2705" : "\u274C";
      statusCell.style.textAlign = "center";
      row.appendChild(statusCell);
      const sourceCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = getEditorBadgeClass(cp.source);
      badge.textContent = `${getEditorIcon(cp.source)} ${cp.source}`;
      sourceCell.appendChild(badge);
      row.appendChild(sourceCell);
      const pathCell = document.createElement("td");
      pathCell.setAttribute("title", cp.path);
      pathCell.style.fontFamily = "var(--vscode-editor-font-family, monospace)";
      pathCell.style.fontSize = "12px";
      pathCell.textContent = cp.path;
      row.appendChild(pathCell);
      tbody.appendChild(row);
    };
    for (const cp of otherEntries) {
      renderRow(cp);
    }
    if (crushEntries.length > 0) {
      const anyExist = crushEntries.some((cp) => cp.exists);
      const row = document.createElement("tr");
      if (!anyExist) {
        row.style.opacity = "0.5";
      }
      const statusCell = document.createElement("td");
      statusCell.textContent = anyExist ? "\u2705" : "\u274C";
      statusCell.style.textAlign = "center";
      row.appendChild(statusCell);
      const sourceCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = getEditorBadgeClass("Crush");
      badge.textContent = `${getEditorIcon("Crush")} Crush`;
      sourceCell.appendChild(badge);
      row.appendChild(sourceCell);
      const pathCell = document.createElement("td");
      pathCell.style.fontFamily = "var(--vscode-editor-font-family, monospace)";
      pathCell.style.fontSize = "12px";
      pathCell.style.lineHeight = "1.6";
      for (const cp of crushEntries) {
        const line = document.createElement("div");
        line.style.opacity = cp.exists ? "1" : "0.5";
        line.title = cp.path;
        line.textContent = `${cp.exists ? "\u2705" : "\u274C"} ${cp.path}`;
        pathCell.appendChild(line);
      }
      row.appendChild(pathCell);
      tbody.appendChild(row);
    }
    return container;
  }
  function getRepoDisplayName(repoUrl) {
    if (!repoUrl) {
      return "";
    }
    let url = repoUrl.replace(/\.git$/, "");
    if (url.includes("@") && url.includes(":")) {
      const colonIndex = url.lastIndexOf(":");
      const atIndex = url.lastIndexOf("@");
      if (colonIndex > atIndex) {
        return url.substring(colonIndex + 1);
      }
    }
    try {
      if (url.includes("://")) {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split("/").filter((p) => p);
        if (pathParts.length >= 2) {
          return `${pathParts[pathParts.length - 2]}/${pathParts[pathParts.length - 1]}`;
        }
        return urlObj.pathname.replace(/^\//, "");
      }
    } catch {
    }
    const parts = url.split("/").filter((p) => p);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
    return url;
  }
  function getEditorBadgeClass(editor) {
    const lower = editor.toLowerCase();
    if (lower.includes("visual studio")) {
      return "editor-badge editor-badge-vs";
    }
    if (lower.includes("visual studio")) {
      return "editor-badge editor-badge-vs";
    }
    if (lower.includes("crush")) {
      return "editor-badge editor-badge-crush";
    }
    return "editor-badge";
  }
  function getEditorIcon(editor) {
    const lower = editor.toLowerCase();
    if (lower.includes("visual studio")) {
      return "\u{1FA9F}";
    }
    if (lower.includes("visual studio")) {
      return "\u{1FA9F}";
    }
    if (lower.includes("crush")) {
      return "\u{1FA77}";
    }
    if (lower.includes("opencode")) {
      return "\u{1F7E2}";
    }
    if (lower.includes("cursor")) {
      return "\u{1F5B1}\uFE0F";
    }
    if (lower.includes("insiders")) {
      return "\u{1F49A}";
    }
    if (lower.includes("vscodium")) {
      return "\u{1F535}";
    }
    if (lower.includes("windsurf")) {
      return "\u{1F3C4}";
    }
    if (lower.includes("vs code") || lower.includes("vscode")) {
      return "\u{1F499}";
    }
    return "\u{1F4DD}";
  }
  function sortSessionFiles(files) {
    return [...files].sort((a, b) => {
      const aVal = a.lastInteraction;
      const bVal = b.lastInteraction;
      if (!aVal && !bVal) {
        return 0;
      }
      if (!aVal) {
        return 1;
      }
      if (!bVal) {
        return -1;
      }
      const aTime = new Date(aVal).getTime();
      const bTime = new Date(bVal).getTime();
      return currentSortDirection === "desc" ? bTime - aTime : aTime - bTime;
    });
  }
  function getSortIndicator(column) {
    if (currentSortColumn !== column) {
      return "";
    }
    return currentSortDirection === "desc" ? " \u25BC" : " \u25B2";
  }
  function getEditorStats(files) {
    const stats = {};
    for (const sf of files) {
      const editor = sf.editorSource || "Unknown";
      if (!stats[editor]) {
        stats[editor] = { count: 0, interactions: 0 };
      }
      stats[editor].count++;
      stats[editor].interactions += sf.interactions;
    }
    return stats;
  }
  function safeText(value) {
    if (value === null || value === void 0) {
      return "";
    }
    return escapeHtml(String(value));
  }
  function renderSessionTable(detailedFiles, isLoading = false) {
    if (isLoading) {
      return `
			<div class="loading-state">
				<div class="loading-spinner">\u23F3</div>
				<div class="loading-text">Loading session files...</div>
				<div class="loading-subtext">Analyzing up to 500 files from the last 14 days</div>
			</div>
		`;
    }
    if (detailedFiles.length === 0) {
      return '<p style="color: #999;">No session files with activity in the last 14 days.</p>';
    }
    const editorStats = getEditorStats(detailedFiles);
    const editors = Object.keys(editorStats).sort();
    let filteredFiles = currentEditorFilter ? detailedFiles.filter((sf) => sf.editorSource === currentEditorFilter) : detailedFiles;
    if (currentContextRefFilter) {
      filteredFiles = filteredFiles.filter((sf) => {
        const refType = currentContextRefFilter;
        const value = sf.contextReferences[refType];
        return typeof value === "number" && value > 0;
      });
    }
    const totalInteractions = filteredFiles.reduce(
      (sum, sf) => sum + Number(sf.interactions || 0),
      0
    );
    const totalContextRefs = filteredFiles.reduce(
      (sum, sf) => sum + getTotalContextRefs(sf.contextReferences),
      0
    );
    const aggContextRefs = filteredFiles.reduce(
      (agg, sf) => {
        const r = sf.contextReferences;
        agg.file += r.file;
        agg.symbol += r.symbol;
        agg.selection += r.selection;
        agg.implicitSelection += r.implicitSelection;
        agg.codebase += r.codebase;
        agg.workspace += r.workspace;
        agg.terminal += r.terminal;
        agg.vscode += r.vscode;
        agg.copilotInstructions += r.copilotInstructions;
        agg.agentsMd += r.agentsMd;
        return agg;
      },
      {
        file: 0,
        symbol: 0,
        selection: 0,
        implicitSelection: 0,
        codebase: 0,
        workspace: 0,
        terminal: 0,
        vscode: 0,
        copilotInstructions: 0,
        agentsMd: 0
      }
    );
    const sortedFiles = sortSessionFiles(filteredFiles);
    const editorPanelsHtml = `
		<div class="editor-filter-panels">
			<div class="editor-panel ${currentEditorFilter === null ? "active" : ""}" data-editor="">
				<div class="editor-panel-icon">\u{1F310}</div>
				<div class="editor-panel-name">All Editors</div>
				<div class="editor-panel-stats">${detailedFiles.length} sessions</div>
			</div>
			${editors.map(
      (editor) => `
				<div class="editor-panel ${currentEditorFilter === editor ? "active" : ""}" data-editor="${escapeHtml(editor)}">
					<div class="editor-panel-icon">${getEditorIcon(editor)}</div>
					<div class="editor-panel-name">${escapeHtml(editor)}</div>
					<div class="editor-panel-stats">${editorStats[editor].count} sessions \xB7 ${editorStats[editor].interactions} interactions</div>
				</div>
			`
    ).join("")}
		</div>
	`;
    return `
		${editorPanelsHtml}

		<div class="summary-cards">
			<div class="summary-card">
				<div class="summary-label">\u{1F4C1} ${currentEditorFilter ? "Filtered" : "Total"} Sessions</div>
				<div class="summary-value">${filteredFiles.length}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">\u{1F4AC} Interactions</div>
				<div class="summary-value">${totalInteractions}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">\u{1F517} Context References</div>
				<div class="summary-value">${safeText(totalContextRefs)}</div>
				<div class="summary-sub">
				${totalContextRefs === 0 ? "None" : ""}
				${aggContextRefs.file > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "file" ? "active" : ""}" data-ref-type="file">#file ${aggContextRefs.file}</div>` : ""}
				${aggContextRefs.symbol > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "symbol" ? "active" : ""}" data-ref-type="symbol">#sym ${aggContextRefs.symbol}</div>` : ""}
				${aggContextRefs.implicitSelection > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "implicitSelection" ? "active" : ""}" data-ref-type="implicitSelection">implicit ${aggContextRefs.implicitSelection}</div>` : ""}
				${aggContextRefs.copilotInstructions > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "copilotInstructions" ? "active" : ""}" data-ref-type="copilotInstructions">\u{1F4CB} instructions ${aggContextRefs.copilotInstructions}</div>` : ""}
				${aggContextRefs.agentsMd > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "agentsMd" ? "active" : ""}" data-ref-type="agentsMd">\u{1F916} agents ${aggContextRefs.agentsMd}</div>` : ""}
				${aggContextRefs.workspace > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "workspace" ? "active" : ""}" data-ref-type="workspace">@workspace ${aggContextRefs.workspace}</div>` : ""}
				${aggContextRefs.vscode > 0 ? `<div class="context-ref-filter ${currentContextRefFilter === "vscode" ? "active" : ""}" data-ref-type="vscode">@vscode ${aggContextRefs.vscode}</div>` : ""}
				</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">\u{1F4C5} Time Range</div>
				<div class="summary-value">Last 14 days</div>
			</div>
		</div>

		<div class="table-container">
			<table class="session-table">
				<thead>
					<tr>
						<th>#</th>
						<th>Editor</th>
						<th>Title</th>
						<th>Repository</th>
						<th>Size</th>
						<th>Interactions</th>
						<th>Context Refs</th>
						<th class="sortable" data-sort="lastInteraction">Last Interaction${getSortIndicator("lastInteraction")}</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					${sortedFiles.map(
      (sf, idx) => `
						<tr>
							<td>${idx + 1}</td>
							<td><span class="${getEditorBadgeClass(sf.editorName || sf.editorSource)}" title="${escapeHtml(sf.editorSource)}">${getEditorIcon(sf.editorName || sf.editorSource)} ${escapeHtml(sf.editorName || sf.editorSource)}</span></td>
							<td class="session-title" title="${sf.title ? escapeHtml(sf.title) : "Empty session"}">
								${sf.title ? `<a href="#" class="session-file-link" data-file="${encodeURIComponent(sf.file)}" title="${escapeHtml(sf.title)}">${escapeHtml(sf.title.length > 40 ? sf.title.substring(0, 40) + "..." : sf.title)}</a>` : `<a href="#" class="session-file-link empty-session-link" data-file="${encodeURIComponent(sf.file)}" title="Empty session">(Empty session)</a>`}
							</td>
							<td class="repository-cell" title="${sf.repository ? escapeHtml(sf.repository) : "No repository detected"}">${sf.repository ? escapeHtml(getRepoDisplayName(sf.repository)) : '<span style="color: #666;">\u2014</span>'}</td>
							<td>${formatFileSize(sf.size)}</td>
							<td>${sanitizeNumber(sf.interactions)}</td>
							<td title="${escapeHtml(getContextRefsSummary(sf.contextReferences))}">${sanitizeNumber(getTotalContextRefs(sf.contextReferences))}</td>
							<td>${formatDate(sf.lastInteraction)}</td>
							<td>
								<a href="#" class="view-formatted-link" data-file="${encodeURIComponent(sf.file)}" title="View formatted JSONL file">\u{1F4C4} View</a>
							</td>
						</tr>
					`
    ).join("")}
				</tbody>
			</table>
		</div>
	`;
  }
  function counterRow(key, label, value) {
    return `
    <tr>
      <td style="padding: 6px 12px 6px 0; color: var(--vscode-descriptionForeground); white-space: nowrap;">${escapeHtml(label)}</td>
      <td style="padding: 6px 8px 6px 0;">
        <input type="number" class="debug-counter-input" data-key="${escapeHtml(key)}" value="${value}" min="0" step="1"
          style="width:70px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 2px 6px; font-family: var(--vscode-editor-font-family, monospace);" />
      </td>
      <td style="padding: 6px 0;">
        <button class="button secondary debug-counter-set" data-key="${escapeHtml(key)}" style="padding: 2px 10px; font-size: 12px;">Set</button>
      </td>
    </tr>`;
  }
  function stringRow(key, label, value) {
    const display2 = value ? `\u2705 ${escapeHtml(value)}` : "\u274C (not set)";
    return `
    <tr>
      <td style="padding: 6px 12px 6px 0; color: var(--vscode-descriptionForeground); white-space: nowrap;">${escapeHtml(label)}</td>
      <td style="padding: 6px 8px 6px 0;" colspan="2">
        <span style="font-family: var(--vscode-editor-font-family, monospace);">${display2}</span>
      </td>
    </tr>`;
  }
  function flagRow(key, label, value) {
    return `
    <tr>
      <td style="padding: 6px 12px 6px 0; color: var(--vscode-descriptionForeground); white-space: nowrap;">${escapeHtml(label)}</td>
      <td style="padding: 6px 8px 6px 0;">
        <input type="checkbox" class="debug-flag-input" data-key="${escapeHtml(key)}" ${value ? "checked" : ""} />
        <span style="margin-left:6px; font-family: var(--vscode-editor-font-family, monospace);">${value ? "\u2705 true" : "\u274C false"}</span>
      </td>
      <td style="padding: 6px 0;">
        <button class="button secondary debug-flag-set" data-key="${escapeHtml(key)}" style="padding: 2px 10px; font-size: 12px;">Set</button>
      </td>
    </tr>`;
  }
  function renderDebugTab(counters) {
    const c = counters ?? { openCount: 0, unknownMcpOpenCount: 0, fluencyBannerDismissed: false, unknownMcpDismissedVersion: "" };
    return `
    <div id="tab-debug" class="tab-content">
      <div class="info-box">
        <div class="info-box-title">\u{1F41B} Debug \u2014 Global State Counters</div>
        <div>Visible only when a debugger is attached. Edit counters and dismissed flags stored in VS Code global state, then click Set to apply. Changes take effect immediately.</div>
      </div>
      <div class="cache-details">
        <h4>Notification Counters</h4>
        <table><tbody>
          ${counterRow("extension.openCount", "extension.openCount (fluency banner threshold: 5)", c.openCount)}
          ${counterRow("extension.unknownMcpOpenCount", "extension.unknownMcpOpenCount (unknown MCP threshold: 8)", c.unknownMcpOpenCount)}
        </tbody></table>
        <h4 style="margin-top:16px;">Dismissed Flags</h4>
        <table><tbody>
          ${flagRow("news.fluencyScoreBanner.v1.dismissed", "news.fluencyScoreBanner.v1.dismissed", c.fluencyBannerDismissed)}
          ${stringRow("news.unknownMcpTools.dismissedVersion", "news.unknownMcpTools.dismissedVersion", c.unknownMcpDismissedVersion)}
        </tbody></table>
        <div style="margin-top: 16px;">
          <button class="button secondary" id="btn-reset-debug-counters"><span>\u{1F504}</span><span>Reset All Counters &amp; Dismissed Flags</span></button>
        </div>
      </div>
    </div>`;
  }
  function renderBackendStoragePanel(backendInfo) {
    if (!backendInfo) {
      return `
			<div class="info-box">
				<div class="info-box-title">\u2601\uFE0F Azure Storage Backend</div>
				<div>
					Backend storage information is not available. This may be a temporary issue.
				</div>
			</div>
		`;
    }
    const statusColor = backendInfo.isConfigured ? "#2d6a4f" : backendInfo.enabled ? "#d97706" : "#666";
    const statusIcon = backendInfo.isConfigured ? "\u2705" : backendInfo.enabled ? "\u26A0\uFE0F" : "\u26AA";
    const statusText = backendInfo.isConfigured ? "Configured & Enabled" : backendInfo.enabled ? "Enabled but Not Configured" : "Disabled";
    const configButtonText = backendInfo.isConfigured ? "\u2699\uFE0F Manage Backend" : "\u{1F527} Configure Backend";
    const configButtonStyle = backendInfo.isConfigured ? "secondary" : "";
    return `
		<div class="info-box">
			<div class="info-box-title">\u2601\uFE0F Azure Storage Backend</div>
			<div>
				Sync your token usage data to Azure Storage Tables for team-wide reporting and multi-device access.
				Configure Azure resources and authentication settings to enable cloud synchronization.
			</div>
		</div>

		<div class="summary-cards">
			<div class="summary-card" style="border-left: 4px solid ${statusColor};">
				<div class="summary-label">${statusIcon} Backend Status</div>
				<div class="summary-value" style="font-size: 16px; color: ${statusColor};">${statusText}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">\u{1F510} Auth Mode</div>
				<div class="summary-value" style="font-size: 16px;">${backendInfo.authMode === "entraId" ? "Entra ID" : "Shared Key"}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">\u{1F465} Sharing Profile</div>
				<div class="summary-value" style="font-size: 14px;">${escapeHtml(backendInfo.sharingProfile)}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">\u{1F552} Last Sync</div>
				<div class="summary-value" style="font-size: 14px;">${backendInfo.lastSyncTime ? getTimeSince(backendInfo.lastSyncTime) : "Never"}</div>
			</div>
		</div>

		${backendInfo.isConfigured ? `
			<div style="margin-top: 24px;">
				<h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">\u{1F4CA} Configuration Details</h4>
				<table class="session-table">
					<tbody>
						<tr>
							<td style="font-weight: 600; width: 200px;">Storage Account</td>
							<td>${escapeHtml(backendInfo.storageAccount)}</td>
						</tr>
						<tr>
							<td style="font-weight: 600;">Subscription ID</td>
							<td>${escapeHtml(backendInfo.subscriptionId)}</td>
						</tr>
						<tr>
							<td style="font-weight: 600;">Resource Group</td>
							<td>${escapeHtml(backendInfo.resourceGroup)}</td>
						</tr>
						<tr>
							<td style="font-weight: 600;">Aggregation Table</td>
							<td>${escapeHtml(backendInfo.aggTable)}</td>
						</tr>
						<tr>
							<td style="font-weight: 600;">Events Table</td>
							<td>${escapeHtml(backendInfo.eventsTable)}</td>
						</tr>
					</tbody>
				</table>
			</div>

			<div style="margin-top: 24px;">
				<h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">\u{1F4C8} Local Session Statistics</h4>
				<div class="summary-cards">
					<div class="summary-card">
						<div class="summary-label">\u{1F4BB} Unique Devices</div>
						<div class="summary-value">${escapeHtml(String(backendInfo.deviceCount))}</div>
						<div style="font-size: 11px; color: #999; margin-top: 4px;">Based on workspace IDs</div>
					</div>
					<div class="summary-card">
						<div class="summary-label">\u{1F4C1} Total Sessions</div>
						<div class="summary-value">${escapeHtml(String(backendInfo.sessionCount))}</div>
						<div style="font-size: 11px; color: #999; margin-top: 4px;">Local session files</div>
					</div>
					<div class="summary-card">
						<div class="summary-label">\u2601\uFE0F Cloud Records</div>
						<div class="summary-value">${backendInfo.recordCount !== null ? escapeHtml(String(backendInfo.recordCount)) : "\u2014"}</div>
						<div style="font-size: 11px; color: #999; margin-top: 4px;">Azure Storage records</div>
					</div>
					<div class="summary-card">
						<div class="summary-label">\u{1F504} Sync Status</div>
						<div class="summary-value" style="font-size: 14px;">${backendInfo.lastSyncTime ? formatDate(backendInfo.lastSyncTime) : "Never"}</div>
					</div>
				</div>
			</div>

			<div style="margin-top: 24px;">
				<h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">\u2139\uFE0F About Azure Storage Backend</h4>
				<p style="color: #999; font-size: 12px; margin-bottom: 8px;">
					The Azure Storage backend enables:
				</p>
				<ul style="margin: 8px 0 0 20px; color: #999; font-size: 12px;">
					<li>Team-wide token usage reporting and analytics</li>
					<li>Multi-device synchronization of your usage data</li>
					<li>Long-term storage and historical analysis</li>
					<li>Configurable privacy levels (anonymous, pseudonymous, or identified)</li>
				</ul>
			</div>
		` : `
			<div style="margin-top: 24px;">
				<h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">\u{1F680} Get Started with Azure Storage</h4>
				<p style="color: #999; font-size: 12px; margin-bottom: 16px;">
					To enable cloud synchronization, you'll need to configure an Azure Storage account.
					The setup wizard will guide you through the process.
				</p>
				<ul style="margin: 8px 0 16px 20px; color: #999; font-size: 12px;">
					<li>Azure subscription with Storage Account access</li>
					<li>Appropriate permissions (Storage Table Data Contributor or Storage Account Key)</li>
					<li>VS Code signed in with your Azure account (for Entra ID auth)</li>
				</ul>
			</div>
		`}

		<div class="button-group">
			<button class="button ${configButtonStyle}" id="btn-configure-backend">
				<span>${configButtonText.split(" ")[0]}</span>
				<span>${configButtonText.substring(configButtonText.indexOf(" ") + 1)}</span>
			</button>
			${backendInfo.isConfigured ? `
				<button class="button secondary" id="btn-open-settings">
					<span>\u2699\uFE0F</span>
					<span>Open Backend Settings</span>
				</button>
			` : ""}
		</div>
	`;
  }
  function renderLayout(data) {
    const root = document.getElementById("root");
    if (!root) {
      return;
    }
    let sessionFilesHtml = "";
    const sessionFolders = data.sessionFolders || [];
    if (sessionFolders.length > 0) {
      const sorted = [...sessionFolders].sort((a, b) => b.count - a.count);
      sessionFilesHtml = `
			<div class="session-folders-table">
				<h4>Main Session Folders (by editor root):</h4>
				<table class="session-table">
					<thead>
						<tr>
							<th>Folder</th>
							<th>Editor</th>
							<th># of Sessions</th>
							<th>Open</th>
						</tr>
					</thead>
					<tbody>`;
      const totalSessions = sorted.reduce((sum, sf) => sum + sf.count, 0);
      console.log(
        "[Diagnostics] Total sessions calculated:",
        totalSessions,
        "from",
        sorted.length,
        "folders"
      );
      sorted.forEach(
        (sf) => {
          let display2 = sf.dir;
          const home = window.process?.env?.HOME || window.process?.env?.USERPROFILE || "";
          if (home && display2.startsWith(home)) {
            display2 = display2.replace(home, "~");
          }
          const editorName = sf.editorName || "Unknown";
          sessionFilesHtml += `
				<tr>
					<td title="${escapeHtml(sf.dir)}">${escapeHtml(display2)}</td>
				<td><span class="${getEditorBadgeClass(editorName)}">${getEditorIcon(editorName)} ${escapeHtml(editorName)}</span></td>
					<td>${sf.count}</td>
					<td><a href="#" class="reveal-link" data-path="${encodeURIComponent(sf.dir)}">Open directory</a></td>
				</tr>`;
        }
      );
      sessionFilesHtml += `
				<tr style="border-top: 2px solid #5a5a5a; font-weight: 600; background: rgba(255, 255, 255, 0.05);">
					<td colspan="2" style="text-align: right; padding-right: 16px;">Total:</td>
					<td>${totalSessions}</td>
					<td></td>
				</tr>`;
      console.log("[Diagnostics] Total row HTML added to sessionFilesHtml");
      sessionFilesHtml += `
					</tbody>
				</table>
			</div>`;
    }
    let escapedReport = escapeHtml(data.report);
    const reportIsLoading = data.report === LOADING_PLACEHOLDER;
    if (!reportIsLoading) {
      escapedReport = removeSessionFilesSection(escapedReport);
    } else {
      escapedReport = LOADING_MESSAGE.trim();
    }
    const detailedFiles = data.detailedSessionFiles || [];
    root.innerHTML = `
		<style>${theme_default}</style>
		<style>${styles_default}</style>
		<div class="container">
			<div class="header">
				<div class="header-left">
					<span class="header-icon">\u{1F50D}</span>
					<span class="header-title">Diagnostic Report</span>
				</div>
				<div class="button-row">
					${buttonHtml("btn-refresh")}
					${buttonHtml("btn-details")}
					${buttonHtml("btn-chart")}
					${buttonHtml("btn-usage")}
					${buttonHtml("btn-environmental")}
					${buttonHtml("btn-maturity")}
					${data?.backendConfigured ? buttonHtml("btn-dashboard") : ""}
				</div>
			</div>

			<div class="tabs">
				<button class="tab active" data-tab="report">\u{1F4CB} Report</button>
				<button class="tab" data-tab="sessions">\u{1F4C1} Session Files (${detailedFiles.length})</button>
				<button class="tab" data-tab="cache">\u{1F4BE} Cache</button>
				<button class="tab" data-tab="backend">\u2601\uFE0F Azure Storage</button>
				${data.isDebugMode ? '<button class="tab" data-tab="debug">\u{1F41B} Debug</button>' : ""}
			</div>

			<div id="tab-report" class="tab-content active">
				<div class="info-box">
					<div class="info-box-title">\u{1F4CB} About This Report</div>
					<div>
						This diagnostic report contains information about your GitHub Copilot Token Tracker
						extension setup and usage statistics. </br> It does <strong>not</strong> include any of your
						code or conversation content. You can safely share this report when reporting issues.
					</div>
				</div>
				<div class="report-content">${escapedReport}</div>
				${sessionFilesHtml}
				<div class="button-group">
					<button class="button" id="btn-copy"><span>\u{1F4CB}</span><span>Copy to Clipboard</span></button>
					<button class="button secondary" id="btn-issue"><span>\u{1F41B}</span><span>Open GitHub Issue</span></button>
					<button class="button secondary" id="btn-clear-cache"><span>\u{1F5D1}\uFE0F</span><span>Clear Cache</span></button>
				</div>
			</div>

			<div id="tab-sessions" class="tab-content">
				<div class="info-box">
					<div class="info-box-title">\u{1F4C1} Session File Analysis</div>
					<div>
						This tab shows session files with activity in the last 14 days from all detected editors. </br>
						Click on an editor panel to filter, click column headers to sort, and click a file name to open it.
					</div>
				</div>
				<div id="session-table-container">${renderSessionTable(detailedFiles, detailedFiles.length === 0)}</div>
			</div>

			<div id="tab-cache" class="tab-content">
				<div class="info-box">
					<div class="info-box-title">\u{1F4BE} Cache Information</div>
					<div>
						The extension caches session file data to improve performance and reduce file system operations.
						Cache is stored in VS Code's global state and persists across sessions.
					</div>
				</div>
				<div class="cache-details">
					<div class="summary-cards">
						<div class="summary-card">
						<div class="summary-label">\u{1F4E6} Cache Entries</div>
						<div class="summary-value">${data.cacheInfo?.size || 0}</div>
					</div>
					<div class="summary-card">
						<div class="summary-label">\u{1F4BE} Cache Size</div>
						<div class="summary-value">${data.cacheInfo?.sizeInMB ? data.cacheInfo.sizeInMB.toFixed(2) + " MB" : "N/A"}</div>
						</div>
						<div class="summary-card">
							<div class="summary-label">\u{1F552} Last Updated</div>
							<div class="summary-value" style="font-size: 14px;">${data.cacheInfo?.lastUpdated ? formatDate(data.cacheInfo.lastUpdated) : "Never"}</div>
						</div>
						<div class="summary-card">
							<div class="summary-label">\u23F1\uFE0F Cache Age</div>
							<div class="summary-value" style="font-size: 14px;">${data.cacheInfo?.lastUpdated ? getTimeSince(data.cacheInfo.lastUpdated) : "N/A"}</div>
						</div>
					</div>
					<div class="cache-location">
						<h4>Storage Location</h4>
						<div class="location-box">
							<code>${escapeHtml(data.cacheInfo?.location || "VS Code Global State")}</code>
							${data.cacheInfo?.storagePath ? ` <a href="#" class="open-storage-link" data-path="${encodeURIComponent(data.cacheInfo.storagePath)}">Open storage location</a>` : ""}
						</div>
						<p style="color: #999; font-size: 12px; margin-top: 8px;">
							Cache is stored in VS Code's global state (extension storage) and includes:
							<ul style="margin: 8px 0 0 20px;">
								<li>Token counts per session file</li>
								<li>Interaction counts</li>
								<li>Model usage statistics</li>
								<li>File modification timestamps for validation</li>
								<li>Usage analysis data (tool calls, modes, context references)</li>
							</ul>
						</p>
					</div>
					<div class="cache-actions">
						<h4>Cache Management</h4>
						<p style="color: #999; font-size: 12px; margin-bottom: 12px;">
							Clearing the cache will force the extension to re-read and re-analyze all session files on the next update.
							This can help resolve issues with stale or incorrect data.
						</p>
						<button class="button secondary" id="btn-clear-cache-tab"><span>\u{1F5D1}\uFE0F</span><span>Clear Cache</span></button>
					</div>
				</div>
			</div>

			<div id="tab-backend" class="tab-content">
				${renderBackendStoragePanel(data.backendStorageInfo)}
			</div>
			${data.isDebugMode ? renderDebugTab(data.globalStateCounters) : ""}
		</div>
	`;
    let storedDetailedFiles = detailedFiles;
    let isLoading = detailedFiles.length === 0;
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.command === "diagnosticDataLoaded") {
        if (message.report) {
          const reportTabContent = document.getElementById("tab-report");
          if (reportTabContent) {
            const processedReport = removeSessionFilesSection(message.report);
            const reportPre = reportTabContent.querySelector(".report-content");
            if (reportPre) {
              reportPre.textContent = processedReport;
            }
          }
        }
        if (message.backendStorageInfo) {
          const backendTabContent = document.getElementById("tab-backend");
          if (backendTabContent) {
            backendTabContent.innerHTML = renderBackendStoragePanel(
              message.backendStorageInfo
            );
            setupBackendButtonHandlers();
          }
        } else {
          console.warn("diagnosticDataLoaded received but backendStorageInfo is missing or undefined");
        }
        if (message.sessionFolders && message.sessionFolders.length > 0) {
          const reportTabContent = document.getElementById("tab-report");
          if (reportTabContent) {
            const sorted = [...message.sessionFolders].sort(
              (a, b) => b.count - a.count
            );
            let container = reportTabContent.querySelector(
              ".session-folders-table"
            );
            if (!container) {
              container = document.createElement("div");
              container.className = "session-folders-table";
            } else {
              while (container.firstChild) {
                container.removeChild(container.firstChild);
              }
            }
            const heading = document.createElement("h4");
            heading.textContent = "Main Session Folders (by editor root):";
            container.appendChild(heading);
            const table = document.createElement("table");
            table.className = "session-table";
            container.appendChild(table);
            const thead = document.createElement("thead");
            table.appendChild(thead);
            const headerRow = document.createElement("tr");
            thead.appendChild(headerRow);
            const headers = ["Folder", "Editor", "# of Sessions", "Open"];
            headers.forEach((text) => {
              const th = document.createElement("th");
              th.textContent = text;
              headerRow.appendChild(th);
            });
            const tbody = document.createElement("tbody");
            table.appendChild(tbody);
            sorted.forEach((sf) => {
              let display2 = sf.dir;
              const home = window.process?.env?.HOME || window.process?.env?.USERPROFILE || "";
              if (home && display2.startsWith(home)) {
                display2 = display2.replace(home, "~");
              }
              const editorName = sf.editorName || "Unknown";
              const row = document.createElement("tr");
              const folderCell = document.createElement("td");
              folderCell.setAttribute("title", escapeHtml(sf.dir));
              folderCell.textContent = escapeHtml(display2);
              row.appendChild(folderCell);
              const editorCell = document.createElement("td");
              const editorBadge = document.createElement("span");
              editorBadge.className = getEditorBadgeClass(editorName);
              editorBadge.textContent = `${getEditorIcon(editorName)} ${escapeHtml(editorName)}`;
              editorCell.appendChild(editorBadge);
              row.appendChild(editorCell);
              const countCell = document.createElement("td");
              countCell.textContent = String(sf.count);
              row.appendChild(countCell);
              const openCell = document.createElement("td");
              const openLink = document.createElement("a");
              openLink.href = "#";
              openLink.className = "reveal-link";
              openLink.setAttribute("data-path", encodeURIComponent(sf.dir));
              openLink.textContent = "Open directory";
              openCell.appendChild(openLink);
              row.appendChild(openCell);
              tbody.appendChild(row);
            });
            const totalSessions = sorted.reduce((sum, sf) => sum + sf.count, 0);
            const totalRow = document.createElement("tr");
            totalRow.style.borderTop = "2px solid var(--vscode-panel-border)";
            totalRow.style.fontWeight = "bold";
            totalRow.style.background = "rgba(255, 255, 255, 0.05)";
            const totalLabelCell = document.createElement("td");
            totalLabelCell.setAttribute("colspan", "2");
            totalLabelCell.style.textAlign = "right";
            totalLabelCell.style.paddingRight = "16px";
            totalLabelCell.textContent = "Total:";
            totalRow.appendChild(totalLabelCell);
            const totalCountCell = document.createElement("td");
            totalCountCell.textContent = totalSessions.toString();
            totalRow.appendChild(totalCountCell);
            const totalEmptyCell = document.createElement("td");
            totalRow.appendChild(totalEmptyCell);
            tbody.appendChild(totalRow);
            const existingTable = reportTabContent.querySelector(
              ".session-folders-table"
            );
            if (!existingTable) {
              const reportContent = reportTabContent.querySelector(".report-content");
              if (reportContent) {
                reportContent.insertAdjacentElement("afterend", container);
              } else {
                reportTabContent.appendChild(container);
              }
            }
            setupStorageLinkHandlers();
          }
        }
        if (message.candidatePaths && message.candidatePaths.length > 0) {
          const reportTabContent = document.getElementById("tab-report");
          if (reportTabContent) {
            const existing = reportTabContent.querySelector(".candidate-paths-table");
            if (existing) {
              existing.remove();
            }
            const candidateEl = buildCandidatePathsElement(message.candidatePaths);
            const foldersTable = reportTabContent.querySelector(".session-folders-table");
            if (foldersTable) {
              foldersTable.insertAdjacentElement("afterend", candidateEl);
            } else {
              const reportContent = reportTabContent.querySelector(".report-content");
              if (reportContent) {
                reportContent.insertAdjacentElement("afterend", candidateEl);
              } else {
                reportTabContent.appendChild(candidateEl);
              }
            }
          }
        }
      } else if (message.command === "diagnosticDataError") {
        console.error("Error loading diagnostic data:", message.error);
        const root2 = document.getElementById("root");
        if (root2) {
          const errorDiv = document.createElement("div");
          errorDiv.style.cssText = "color: #ff6b6b; padding: 20px; text-align: center;";
          errorDiv.innerHTML = `
					<h3>\u26A0\uFE0F Error Loading Diagnostic Data</h3>
					<p>${escapeHtml(message.error || "Unknown error")}</p>
				`;
          root2.insertBefore(errorDiv, root2.firstChild);
        }
      } else if (message.command === "sessionFilesLoaded" && message.detailedSessionFiles) {
        storedDetailedFiles = message.detailedSessionFiles;
        isLoading = false;
        const sessionsTab = document.querySelector('.tab[data-tab="sessions"]');
        if (sessionsTab) {
          sessionsTab.textContent = `\u{1F4C1} Session Files (${storedDetailedFiles.length})`;
        }
        reRenderTable();
      } else if (message.command === "cacheCleared") {
        const btnReport = document.getElementById(
          "btn-clear-cache"
        );
        const btnTab = document.getElementById(
          "btn-clear-cache-tab"
        );
        if (btnReport) {
          btnReport.style.background = "#2d6a4f";
          btnReport.innerHTML = "<span>\u2705</span><span>Cache Cleared</span>";
          btnReport.disabled = false;
        }
        if (btnTab) {
          btnTab.style.background = "#2d6a4f";
          btnTab.innerHTML = "<span>\u2705</span><span>Cache Cleared</span>";
          btnTab.disabled = false;
        }
        setTimeout(() => {
          if (btnReport) {
            btnReport.style.background = "";
            btnReport.innerHTML = "<span>\u{1F5D1}\uFE0F</span><span>Clear Cache</span>";
          }
          if (btnTab) {
            btnTab.style.background = "";
            btnTab.innerHTML = "<span>\u{1F5D1}\uFE0F</span><span>Clear Cache</span>";
          }
        }, 2e3);
      } else if (message.command === "cacheRefreshed") {
        if (message.cacheInfo) {
          const cacheInfo = message.cacheInfo;
          const cacheTabContent = document.getElementById("tab-cache");
          if (cacheTabContent) {
            const summaryCards = cacheTabContent.querySelectorAll(".summary-card");
            if (summaryCards.length >= 4) {
              const entriesValue = summaryCards[0]?.querySelector(".summary-value");
              if (entriesValue) {
                entriesValue.textContent = String(cacheInfo.size);
              }
              const sizeValue = summaryCards[1]?.querySelector(".summary-value");
              if (sizeValue) {
                sizeValue.textContent = `${cacheInfo.sizeInMB.toFixed(2)} MB`;
              }
              const lastUpdatedValue = summaryCards[2]?.querySelector(".summary-value");
              if (lastUpdatedValue) {
                const date = new Date(cacheInfo.lastUpdated);
                lastUpdatedValue.textContent = date.toLocaleString();
              }
              const ageValue = summaryCards[3]?.querySelector(".summary-value");
              if (ageValue) {
                ageValue.textContent = "0 seconds ago";
              }
            }
          }
        }
      }
    });
    function setupStorageLinkHandlers() {
      document.querySelectorAll(".open-storage-link").forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const path = decodeURIComponent(
            link.getAttribute("data-path") || ""
          );
          if (path) {
            vscode.postMessage({ command: "revealPath", path });
          }
        });
      });
    }
    function activateTab(tabId) {
      const tabButton = document.querySelector(`.tab[data-tab="${tabId}"]`);
      const tabContent = document.getElementById(`tab-${tabId}`);
      if (tabButton && tabContent) {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        tabButton.classList.add("active");
        tabContent.classList.add("active");
        return true;
      }
      return false;
    }
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const tabId = tab.getAttribute("data-tab");
        if (tabId && activateTab(tabId)) {
          vscode.setState({ activeTab: tabId });
        }
      });
    });
    function setupSortHandlers() {
      document.querySelectorAll(".sortable").forEach((header) => {
        header.addEventListener("click", () => {
          const sortColumn = header.getAttribute(
            "data-sort"
          );
          if (sortColumn) {
            if (currentSortColumn === sortColumn) {
              currentSortDirection = currentSortDirection === "desc" ? "asc" : "desc";
            } else {
              currentSortColumn = sortColumn;
              currentSortDirection = "desc";
            }
            reRenderTable();
          }
        });
      });
    }
    function setupEditorFilterHandlers() {
      document.querySelectorAll(".editor-panel").forEach((panel) => {
        panel.addEventListener("click", () => {
          const editor = panel.getAttribute("data-editor");
          currentEditorFilter = editor === "" ? null : editor;
          reRenderTable();
        });
      });
    }
    function setupContextRefFilterHandlers() {
      document.querySelectorAll(".context-ref-filter").forEach((filter) => {
        filter.addEventListener("click", () => {
          const refType = filter.getAttribute(
            "data-ref-type"
          );
          if (currentContextRefFilter === refType) {
            currentContextRefFilter = null;
          } else {
            currentContextRefFilter = refType;
          }
          reRenderTable();
        });
      });
    }
    function setupBackendButtonHandlers() {
      document.getElementById("btn-configure-backend")?.addEventListener("click", () => {
        vscode.postMessage({ command: "configureBackend" });
      });
      document.getElementById("btn-open-settings")?.addEventListener("click", () => {
        vscode.postMessage({ command: "openSettings" });
      });
    }
    function reRenderTable() {
      const container = document.getElementById("session-table-container");
      if (container) {
        container.innerHTML = renderSessionTable(storedDetailedFiles, isLoading);
        if (!isLoading) {
          setupSortHandlers();
          setupEditorFilterHandlers();
          setupContextRefFilterHandlers();
          setupFileLinks();
        }
      }
    }
    function setupFileLinks() {
      document.querySelectorAll(".session-file-link").forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const file = decodeURIComponent(
            link.getAttribute("data-file") || ""
          );
          vscode.postMessage({ command: "openSessionFile", file });
        });
      });
      document.querySelectorAll(".view-formatted-link").forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const file = decodeURIComponent(
            link.getAttribute("data-file") || ""
          );
          vscode.postMessage({ command: "openFormattedJsonlFile", file });
        });
      });
      document.querySelectorAll(".reveal-link").forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const path = decodeURIComponent(
            link.getAttribute("data-path") || ""
          );
          vscode.postMessage({ command: "revealPath", path });
        });
      });
    }
    document.getElementById("btn-copy")?.addEventListener("click", () => {
      vscode.postMessage({ command: "copyReport" });
    });
    document.getElementById("btn-issue")?.addEventListener("click", () => {
      vscode.postMessage({ command: "openIssue" });
    });
    function updateCacheNumbers() {
      const cacheTabContent = document.getElementById("tab-cache");
      if (cacheTabContent) {
        const summaryCards = cacheTabContent.querySelectorAll(".summary-card");
        if (summaryCards.length >= 4) {
          const entriesValue = summaryCards[0]?.querySelector(".summary-value");
          if (entriesValue) {
            entriesValue.textContent = "0";
          }
          const sizeValue = summaryCards[1]?.querySelector(".summary-value");
          if (sizeValue) {
            sizeValue.textContent = "0 MB";
          }
          const lastUpdatedValue = summaryCards[2]?.querySelector(".summary-value");
          if (lastUpdatedValue) {
            lastUpdatedValue.textContent = "Never";
          }
          const ageValue = summaryCards[3]?.querySelector(".summary-value");
          if (ageValue) {
            ageValue.textContent = "N/A";
          }
        }
      }
    }
    document.getElementById("btn-clear-cache")?.addEventListener("click", () => {
      const btn = document.getElementById(
        "btn-clear-cache"
      );
      if (btn) {
        btn.style.background = "#d97706";
        btn.innerHTML = "<span>\u23F3</span><span>Clearing...</span>";
        btn.disabled = true;
      }
      updateCacheNumbers();
      vscode.postMessage({ command: "clearCache" });
    });
    document.getElementById("btn-clear-cache-tab")?.addEventListener("click", () => {
      const btn = document.getElementById(
        "btn-clear-cache-tab"
      );
      if (btn) {
        btn.style.background = "#d97706";
        btn.innerHTML = "<span>\u23F3</span><span>Clearing...</span>";
        btn.disabled = true;
      }
      updateCacheNumbers();
      vscode.postMessage({ command: "clearCache" });
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) {
        return;
      }
      if (target.id === "btn-clear-cache" || target.id === "btn-clear-cache-tab") {
        target.style.background = "#d97706";
        target.innerHTML = "<span>\u23F3</span><span>Clearing...</span>";
        if (target instanceof HTMLButtonElement) {
          target.disabled = true;
        }
        updateCacheNumbers();
        vscode.postMessage({ command: "clearCache" });
      }
      if (target.id === "btn-reset-debug-counters") {
        vscode.postMessage({ command: "resetDebugCounters" });
      }
      if (target.classList.contains("debug-counter-set")) {
        const key = target.getAttribute("data-key");
        const row = target.closest("tr");
        const input = row?.querySelector(".debug-counter-input");
        if (key && input) {
          const value = parseInt(input.value, 10);
          if (!isNaN(value)) {
            vscode.postMessage({ command: "setDebugCounter", key, value });
          }
        }
      }
      if (target.classList.contains("debug-flag-set")) {
        const key = target.getAttribute("data-key");
        const row = target.closest("tr");
        const input = row?.querySelector(".debug-flag-input");
        if (key && input) {
          vscode.postMessage({ command: "setDebugFlag", key, value: input.checked });
        }
      }
    });
    document.getElementById("btn-refresh")?.addEventListener(
      "click",
      () => vscode.postMessage({ command: "refresh" })
    );
    document.getElementById("btn-chart")?.addEventListener(
      "click",
      () => vscode.postMessage({ command: "showChart" })
    );
    document.getElementById("btn-usage")?.addEventListener(
      "click",
      () => vscode.postMessage({ command: "showUsageAnalysis" })
    );
    document.getElementById("btn-details")?.addEventListener(
      "click",
      () => vscode.postMessage({ command: "showDetails" })
    );
    document.getElementById("btn-diagnostics")?.addEventListener(
      "click",
      () => vscode.postMessage({ command: "showDiagnostics" })
    );
    document.getElementById("btn-maturity")?.addEventListener(
      "click",
      () => vscode.postMessage({ command: "showMaturity" })
    );
    document.getElementById("btn-dashboard")?.addEventListener(
      "click",
      () => vscode.postMessage({ command: "showDashboard" })
    );
    document.getElementById("btn-environmental")?.addEventListener(
      "click",
      () => vscode.postMessage({ command: "showEnvironmental" })
    );
    setupSortHandlers();
    setupEditorFilterHandlers();
    setupContextRefFilterHandlers();
    setupBackendButtonHandlers();
    setupFileLinks();
    setupStorageLinkHandlers();
    const savedState = vscode.getState();
    if (savedState?.activeTab && !activateTab(savedState.activeTab)) {
      activateTab("report");
    }
  }
  async function bootstrap() {
    const { provideVSCodeDesignSystem: provideVSCodeDesignSystem2, vsCodeButton: vsCodeButton2 } = await Promise.resolve().then(() => (init_dist3(), dist_exports));
    provideVSCodeDesignSystem2().register(vsCodeButton2());
    if (!initialData) {
      const root = document.getElementById("root");
      if (root) {
        root.textContent = "No data available.";
      }
      return;
    }
    renderLayout(initialData);
  }
  void bootstrap();
})();
/*! Bundled license information:

tslib/tslib.es6.js:
  (*! *****************************************************************************
  Copyright (c) Microsoft Corporation.
  
  Permission to use, copy, modify, and/or distribute this software for any
  purpose with or without fee is hereby granted.
  
  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
  REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
  AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
  INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
  LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
  OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
  PERFORMANCE OF THIS SOFTWARE.
  ***************************************************************************** *)

tabbable/dist/index.esm.js:
  (*!
  * tabbable 5.3.3
  * @license MIT, https://github.com/focus-trap/tabbable/blob/master/LICENSE
  *)
*/
//# sourceMappingURL=diagnostics.js.map
