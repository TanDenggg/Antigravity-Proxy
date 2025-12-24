/**
 * Toast 通知管理器
 * 提供多种类型的通知，支持持久化、操作按钮、加载状态更新
 */

class ToastManager {
  constructor() {
    this._container = null;
    this._toasts = new Set();
    this._maxVisible = 5;
    this._init();
  }

  /**
   * 初始化容器
   * @private
   */
  _init() {
    // 确保 DOM 已就绪
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._createContainer());
    } else {
      this._createContainer();
    }
  }

  /**
   * 创建容器
   * @private
   */
  _createContainer() {
    if (this._container) return;
    
    this._container = document.createElement('div');
    this._container.className = 'toast-container';
    this._container.setAttribute('aria-live', 'polite');
    this._container.setAttribute('aria-label', '通知');
    document.body.appendChild(this._container);
  }

  /**
   * 显示通知
   * @param {string} message - 消息内容
   * @param {string} type - 类型：info, success, error, warning, loading
   * @param {Object} options - 选项
   * @returns {Object} toast 控制对象 { update, close }
   */
  show(message, type = 'info', options = {}) {
    this._createContainer();

    const {
      duration = 3000,
      action = null,      // { text: string, onClick: Function }
      persistent = false, // 是否持久显示（需手动关闭）
      id = null          // 自定义ID，用于更新特定toast
    } = options;

    // 如果有相同ID的toast，先移除
    if (id) {
      this._removeById(id);
    }

    const icons = {
      info: 'ℹ️',
      success: '✅',
      error: '❌',
      warning: '⚠️',
      loading: ''
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');
    if (id) toast.dataset.toastId = id;

    toast.innerHTML = `
      ${type === 'loading' 
        ? '<div class="spinner"></div>' 
        : `<span class="toast-icon">${icons[type] || icons.info}</span>`
      }
      <span class="toast-message">${this._escape(message)}</span>
      ${action ? `
        <button class="toast-action" type="button">${this._escape(action.text)}</button>
      ` : ''}
      ${persistent || type === 'loading' ? `
        <button class="toast-close" type="button" aria-label="关闭">✕</button>
      ` : ''}
    `;

    // 绑定事件
    if (action) {
      const actionBtn = toast.querySelector('.toast-action');
      actionBtn.addEventListener('click', () => {
        action.onClick?.();
        this._remove(toast);
      });
    }

    const closeBtn = toast.querySelector('.toast-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this._remove(toast));
    }

    // 添加到容器
    this._container.appendChild(toast);
    this._toasts.add(toast);

    // 限制最大显示数量
    this._enforceMaxVisible();

    // 触发动画
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // 自动关闭
    let timeoutId = null;
    if (!persistent && type !== 'loading' && duration > 0) {
      timeoutId = setTimeout(() => this._remove(toast), duration);
    }

    // 返回控制对象
    return {
      /**
       * 更新消息和类型
       */
      update: (newMessage, newType) => {
        // 清除自动关闭定时器
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        toast.className = `toast toast-${newType || type} show`;
        
        const messageEl = toast.querySelector('.toast-message');
        if (messageEl) {
          messageEl.textContent = newMessage;
        }

        // 更新图标
        const iconEl = toast.querySelector('.toast-icon');
        const spinner = toast.querySelector('.spinner');
        
        if (newType && newType !== 'loading') {
          if (spinner) {
            spinner.remove();
          }
          if (!iconEl) {
            const newIcon = document.createElement('span');
            newIcon.className = 'toast-icon';
            newIcon.textContent = icons[newType] || icons.info;
            toast.insertBefore(newIcon, messageEl);
          } else {
            iconEl.textContent = icons[newType] || icons.info;
          }
        }

        // 如果更新为非loading类型，设置自动关闭
        if (newType && newType !== 'loading' && !persistent) {
          timeoutId = setTimeout(() => this._remove(toast), duration);
        }
      },

      /**
       * 关闭通知
       */
      close: () => this._remove(toast),

      /**
       * 获取 DOM 元素
       */
      element: toast
    };
  }

  /**
   * 移除toast
   * @private
   */
  _remove(toast) {
    if (!toast || !this._toasts.has(toast)) return;

    toast.classList.remove('show');
    this._toasts.delete(toast);

    setTimeout(() => {
      if (toast.parentNode) {
        toast.remove();
      }
    }, 400);
  }

  /**
   * 通过ID移除
   * @private
   */
  _removeById(id) {
    const toast = this._container?.querySelector(`[data-toast-id="${id}"]`);
    if (toast) {
      this._remove(toast);
    }
  }

  /**
   * 限制最大显示数量
   * @private
   */
  _enforceMaxVisible() {
    while (this._toasts.size > this._maxVisible) {
      const oldest = this._toasts.values().next().value;
      this._remove(oldest);
    }
  }

  /**
   * HTML转义
   * @private
   */
  _escape(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }

  // ============ 便捷方法 ============

  info(message, options) {
    return this.show(message, 'info', options);
  }

  success(message, options) {
    return this.show(message, 'success', options);
  }

  error(message, options) {
    return this.show(message, 'error', options);
  }

  warning(message, options) {
    return this.show(message, 'warning', options);
  }

  /**
   * 显示加载状态（持久显示，需手动关闭或更新）
   */
  loading(message, options = {}) {
    return this.show(message, 'loading', { ...options, persistent: true });
  }

  /**
   * 清除所有通知
   */
  clear() {
    this._toasts.forEach(toast => this._remove(toast));
  }
}

// 创建全局实例
export const toast = new ToastManager();

export default toast;