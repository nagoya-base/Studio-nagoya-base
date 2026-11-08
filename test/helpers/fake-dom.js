/*
 * 管理画面（gas/feedback-admin/FeedbackAdminPage.html。Issue #849）のスクリプトをvmで動かすための最小DOM。
 * 画面が使うAPI（getElementById / createElement / createTextNode / appendChild / removeChild / firstChild /
 * textContent / setAttribute / className / hidden / value / checked / selected / disabled / addEventListener）だけを実装する。
 * HTMLの描画やCSSは再現しない（見た目の確認は実ブラウザで行う）。
 */
'use strict';

function FakeNode(tagName, text) {
  this.tagName = tagName;
  this.childNodes = [];
  this.parentNode = null;
  this.attributes = {};
  this.listeners = {};
  this.className = '';
  this.hidden = false;
  this.disabled = false;
  this.checked = false;
  this.selected = false;
  this._text = text === undefined ? null : String(text);
  this._value = undefined;
}

FakeNode.prototype.appendChild = function (child) {
  if (child.parentNode) child.parentNode.removeChild(child);
  child.parentNode = this;
  this.childNodes.push(child);
  return child;
};
FakeNode.prototype.removeChild = function (child) {
  var i = this.childNodes.indexOf(child);
  if (i !== -1) this.childNodes.splice(i, 1);
  child.parentNode = null;
  return child;
};
Object.defineProperty(FakeNode.prototype, 'firstChild', { get: function () { return this.childNodes[0] || null; } });
Object.defineProperty(FakeNode.prototype, 'textContent', {
  get: function () {
    if (this._text !== null) return this._text;
    return this.childNodes.map(function (c) { return c.textContent; }).join('');
  },
  set: function (value) {
    this.childNodes.slice().forEach(function (c) { c.parentNode = null; });
    this.childNodes = [];
    if (this.tagName === '#text') this._text = String(value);
    else this.appendChild(new FakeNode('#text', value));
  }
});
Object.defineProperty(FakeNode.prototype, 'value', {
  get: function () {
    if (this.tagName === 'select') {
      var options = this.childNodes.filter(function (c) { return c.tagName === 'option'; });
      if (this._value !== undefined && options.some(function (o) { return o.value === this._value; }, this)) return this._value;
      var chosen = options.filter(function (o) { return o.selected; })[0] || options[0];
      return chosen ? chosen.value : '';
    }
    if (this.tagName === 'option' && this._value === undefined) return this.getAttribute('value') || this.textContent;
    return this._value === undefined ? (this.getAttribute('value') || '') : this._value;
  },
  set: function (v) { this._value = String(v); }
});
FakeNode.prototype.setAttribute = function (name, value) { this.attributes[name] = String(value); };
FakeNode.prototype.getAttribute = function (name) {
  return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
};
FakeNode.prototype.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
FakeNode.prototype.dispatch = function (type) {
  var self = this;
  (this.listeners[type] || []).forEach(function (fn) { fn.call(self, { type: type, target: self, preventDefault: function () {} }); });
};
FakeNode.prototype.click = function () { if (!this.disabled) this.dispatch('click'); };
/* 子孫を条件で探す（テスト用） */
FakeNode.prototype.findAll = function (predicate) {
  var out = [];
  (function walk(node) {
    node.childNodes.forEach(function (c) { if (predicate(c)) out.push(c); walk(c); });
  })(this);
  return out;
};
FakeNode.prototype.hasClass = function (name) { return (' ' + this.className + ' ').indexOf(' ' + name + ' ') !== -1; };

/* ids: 画面のHTMLに書かれた要素（id → { tag, options }）を作っておく */
function createDocument(elements) {
  var byId = {};
  Object.keys(elements).forEach(function (id) {
    var spec = elements[id];
    var node = new FakeNode(spec.tag);
    node.setAttribute('id', id);
    (spec.options || []).forEach(function (value) {
      var option = new FakeNode('option');
      option.setAttribute('value', value);
      node.appendChild(option);
    });
    if (spec.hidden) node.hidden = true;
    byId[id] = node;
  });
  return {
    byId: byId,
    getElementById: function (id) { return byId[id] || null; },
    createElement: function (tag) { return new FakeNode(String(tag).toLowerCase()); },
    createTextNode: function (text) { return new FakeNode('#text', text); }
  };
}

module.exports = { createDocument: createDocument, FakeNode: FakeNode };
