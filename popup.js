// Popup JavaScript
let currentFormData = null;

document.addEventListener('DOMContentLoaded', function() {
  const scanBtn = document.getElementById('scanBtn');
  const saveBtn = document.getElementById('saveBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  
  scanBtn.addEventListener('click', extractFormData);
  saveBtn.addEventListener('click', saveFormData);
  cancelBtn.addEventListener('click', viewSavedForms);
  
  // Automatically load saved forms list on popup open
  viewSavedForms();
});

async function extractFormData() {
  try {
    // Check if chrome.scripting is available
    if (!chrome.scripting) {
      showStatus('Error: Extension API not available. Please reload the extension.', 'error');
      document.getElementById('formDataContainer').innerHTML = '<p style="color: #999;">Please reload the extension and try again.</p>';
      return;
    }
    
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.id) {
      showStatus('Error: No active tab found', 'error');
      document.getElementById('formDataContainer').innerHTML = '<p style="color: #999;">No active tab found.</p>';
      return;
    }
    
    // Check if the tab URL is accessible
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://')) {
      showStatus('Cannot access browser internal pages', 'error');
      document.getElementById('formDataContainer').innerHTML = '<p style="color: #999;">Cannot extract forms from browser internal pages.</p>';
      return;
    }
    
    // Inject and execute the content script
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: extractFormsFromPage
    });
    
    if (results && results[0] && results[0].result) {
      currentFormData = {
        url: tab.url,
        title: tab.title,
        timestamp: new Date().toISOString(),
        forms: results[0].result
      };
      
      displayFormData(currentFormData);
      document.getElementById('saveSection').style.display = 'block';
      showStatus(`Found ${currentFormData.forms.length} form(s)`, 'info');
    } else {
      document.getElementById('formDataContainer').innerHTML = '<p style="color: #999;">No forms found on this page.</p>';
      showStatus('No forms found on this page', 'info');
      document.getElementById('saveSection').style.display = 'none';
    }
  } catch (error) {
    console.error('Error extracting form data:', error);
    document.getElementById('formDataContainer').innerHTML = `<p style="color: #d9534f;">Error: ${error.message}</p>`;
    showStatus('Error: ' + error.message, 'error');
  }
}

function extractFormsFromPage() {
  // Helper function to generate XPath for an element
  function generateXPath(element) {
    if (element.id) {
      return `//*[@id="${element.id}"]`;
    }
    
    const parts = [];
    let el = element;
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      let index = 0;
      let sibling = el.previousSibling;
      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === el.nodeName) {
          index++;
        }
        sibling = sibling.previousSibling;
      }
      
      const tagName = el.nodeName.toLowerCase();
      const pathIndex = index ? `[${index + 1}]` : '';
      parts.unshift(tagName + pathIndex);
      
      el = el.parentNode;
    }
    
    return parts.length ? '/' + parts.join('/') : '';
  }
  
  // Helper function to generate CSS selector for an element
  function generateSelector(element) {
    if (element.id) {
      return `#${element.id}`;
    }
    
    if (element.name) {
      return `${element.tagName.toLowerCase()}[name="${element.name}"]`;
    }
    
    // Generate a selector based on attributes
    let selector = element.tagName.toLowerCase();
    if (element.type) {
      selector += `[type="${element.type}"]`;
    }
    if (element.className) {
      selector += '.' + element.className.split(' ').join('.');
    }
    
    return selector;
  }
  
  const forms = document.querySelectorAll('form');
  const formDataArray = [];
  
  forms.forEach((form, formIndex) => {
    const formData = {
      formIndex: formIndex,
      formId: form.id || `form-${formIndex}`,
      formName: form.name || '',
      action: form.action || '',
      method: form.method || 'get',
      fields: []
    };
    
    // Get all input fields
    const inputs = form.querySelectorAll('input, textarea, select');
    
    // Convert to array and sort by visual position (top to bottom, left to right)
    const inputsArray = Array.from(inputs);
    inputsArray.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      
      // Sort by vertical position first (top to bottom)
      if (Math.abs(rectA.top - rectB.top) > 5) {
        return rectA.top - rectB.top;
      }
      
      // If on same row (within 5px), sort by horizontal position (left to right)
      return rectA.left - rectB.left;
    });
    
    inputsArray.forEach((input, inputIndex) => {
      const fieldData = {
        type: input.type || input.tagName.toLowerCase(),
        name: input.name || '',
        id: input.id || '',
        value: '',
        selector: generateSelector(input),
        xpath: generateXPath(input)
      };
      
      // Get value based on input type
      if (input.type === 'checkbox' || input.type === 'radio') {
        fieldData.checked = input.checked;
        fieldData.value = input.value;
      } else if (input.tagName.toLowerCase() === 'select') {
        fieldData.value = input.value;
        fieldData.selectedIndex = input.selectedIndex;
      } else if (input.type !== 'file') {
        fieldData.value = input.value;
      }
      
      formData.fields.push(fieldData);
    });
    
    if (formData.fields.length > 0) {
      formDataArray.push(formData);
    }
  });
  
  return formDataArray;
}

function displayFormData(data) {
  const container = document.getElementById('formDataContainer');
  container.innerHTML = '';
  
  // Hide scan button when on scan page
  document.querySelector('.bottom-actions').style.display = 'none';
  
  // Display URL as editable input
  const urlSection = document.createElement('div');
  urlSection.className = 'url-section';
  urlSection.innerHTML = `
    <strong>Page URL:</strong>
    <input type="text" id="pageUrl" class="url-input" value="${data.url}">
  `;
  container.appendChild(urlSection);
  
  if (!data.forms || data.forms.length === 0) {
    container.innerHTML += '<p style="color: #999;">No forms found</p>';
    return;
  }
  
  data.forms.forEach((form, formIndex) => {
    const formSection = document.createElement('div');
    formSection.className = 'form-section';
    formSection.dataset.formIndex = formIndex;
    
    const formTitle = form.formName || form.formId || `Form ${form.formIndex + 1}`;
    let html = `
      <div class="form-name-container">
        <input type="text" class="form-name-input" data-form-index="${formIndex}" value="${formTitle}" placeholder="Form Name">
      </div>
    `;
    
    if (form.fields.length === 0) {
      html += '<p style="color: #999;">No fields found</p>';
    } else {
      form.fields.forEach((field, fieldIndex) => {
        const fieldLabel = field.name || field.id || `${field.type} field`;
        const dataAttr = `data-form="${formIndex}" data-field="${fieldIndex}"`;
        
        html += `<div class="field-item" ${dataAttr}>`;
        html += `<button class="delete-field-btn" ${dataAttr}>Delete</button>`;
        html += `<div class="field-name">${fieldLabel} (${field.type})</div>`;
        
        // Show selector information as editable inputs
        html += `<div class="field-selector">`;
        html += `<div class="selector-row">`;
        html += `<span class="selector-label">XPath:</span>`;
        html += `<input type="text" class="selector-input xpath-input" value="${(field.xpath || '').replace(/"/g, '&quot;')}" ${dataAttr} data-selector-type="xpath" placeholder="XPath selector">`;
        html += `</div>`;
        html += `<div class="selector-row">`;
        html += `<span class="selector-label">CSS:</span>`;
        html += `<input type="text" class="selector-input css-input" value="${(field.selector || '').replace(/"/g, '&quot;')}" ${dataAttr} data-selector-type="selector" placeholder="CSS selector">`;
        html += `</div>`;
        html += `</div>`;
        
        if (field.type === 'checkbox' || field.type === 'radio') {
          html += `
            <label class="checkbox-label">
              <input type="checkbox" ${field.checked ? 'checked' : ''} ${dataAttr}>
              ${field.checked ? 'Checked' : 'Unchecked'}
            </label>
          `;
        } else if (field.type === 'textarea') {
          html += `<textarea rows="3" ${dataAttr}>${field.value || ''}</textarea>`;
        } else if (field.type !== 'file') {
          const inputType = field.type === 'password' ? 'text' : 'text';
          html += `<input type="${inputType}" value="${(field.value || '').replace(/"/g, '&quot;')}" ${dataAttr} placeholder="Empty">`;
        } else {
          html += `<div class="field-value"><em>File field - not captured</em></div>`;
        }
        
        html += `</div>`;
      });
    }
    
    formSection.innerHTML = html;
    container.appendChild(formSection);
  });
  
  // Add delete button event listeners
  const deleteButtons = container.querySelectorAll('.delete-field-btn');
  deleteButtons.forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      const formIndex = this.dataset.form;
      const fieldIndex = this.dataset.field;
      const fieldItem = document.querySelector(`.field-item[data-form="${formIndex}"][data-field="${fieldIndex}"]`);
      
      if (fieldItem) {
        fieldItem.remove();
      }
    });
  });
}

async function saveFormData() {
  if (!currentFormData) {
    showStatus('No form data to save', 'error');
    return;
  }
  
  try {
    // Update URL from the input field
    const urlInput = document.getElementById('pageUrl');
    if (urlInput) {
      currentFormData.url = urlInput.value;
    }
    
    // Update form names from inputs
    const formNameInputs = document.querySelectorAll('.form-name-input');
    formNameInputs.forEach(input => {
      const formIndex = parseInt(input.dataset.formIndex);
      if (currentFormData.forms[formIndex]) {
        currentFormData.forms[formIndex].formName = input.value;
      }
    });
    
    // Collect only visible fields (deleted ones are removed from DOM)
    const visibleInputs = document.querySelectorAll('input[data-form], textarea[data-form]');
    const visibleFieldsSet = new Set();
    
    visibleInputs.forEach(input => {
      const formIndex = parseInt(input.dataset.form);
      const fieldIndex = parseInt(input.dataset.field);
      visibleFieldsSet.add(`${formIndex}-${fieldIndex}`);
      
      if (currentFormData.forms[formIndex] && currentFormData.forms[formIndex].fields[fieldIndex]) {
        const field = currentFormData.forms[formIndex].fields[fieldIndex];
        
        // Update selectors if it's a selector input
        if (input.dataset.selectorType) {
          if (input.dataset.selectorType === 'xpath') {
            field.xpath = input.value;
          } else if (input.dataset.selectorType === 'selector') {
            field.selector = input.value;
          }
        } else if (input.type === 'checkbox') {
          field.checked = input.checked;
        } else {
          field.value = input.value;
        }
      }
    });
    
    // Remove fields that are no longer visible from currentFormData
    currentFormData.forms.forEach((form, formIndex) => {
      form.fields = form.fields.filter((field, fieldIndex) => {
        return visibleFieldsSet.has(`${formIndex}-${fieldIndex}`);
      });
    });
    
    // Get existing saved forms
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    // Add the new form data
    savedForms.push(currentFormData);
    
    // Save back to storage
    await chrome.storage.local.set({ savedForms: savedForms });
    
    showStatus('Form data saved successfully!', 'success');
  } catch (error) {
    console.error('Error saving form data:', error);
    showStatus('Error saving: ' + error.message, 'error');
  }
}

function showStatus(message, type) {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = message;
  statusDiv.className = type;
  
  // Clear status after 3 seconds
  setTimeout(() => {
    statusDiv.textContent = '';
    statusDiv.className = '';
  }, 3000);
}

async function viewSavedForms() {
  try {
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    // Show scan button when viewing saved forms
    document.querySelector('.bottom-actions').style.display = 'block';
    
    const container = document.getElementById('formDataContainer');
    document.getElementById('saveSection').style.display = 'none';
    
    if (savedForms.length === 0) {
      container.innerHTML = '<p class="info-text">No saved forms yet. Scan a page and save form data to see it here.</p>';
      return;
    }
    
    let tableHtml = `
      <table class="saved-forms-table">
        <thead>
          <tr>
            <th>URL</th>
            <th>Form Name</th>
            <th>Fields</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    savedForms.forEach((formData, entryIndex) => {
      formData.forms.forEach((form, formIndex) => {
        const fieldCount = form.fields.length;
        const formName = form.formName || form.formId || `Form ${form.formIndex + 1}`;
        const date = new Date(formData.timestamp).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        tableHtml += `
          <tr>
            <td class="url-cell" title="${formData.url}">${formData.url}</td>
            <td>${formName}</td>
            <td>${fieldCount} field${fieldCount !== 1 ? 's' : ''}</td>
            <td class="date-cell">${date}</td>
            <td class="actions-cell">
              <button class="table-btn fill-btn" data-entry="${entryIndex}" data-form="${formIndex}">Fill</button>
              <button class="table-btn edit-btn" data-entry="${entryIndex}" data-form="${formIndex}">Edit</button>
              <button class="table-btn delete-btn" data-entry="${entryIndex}" data-form="${formIndex}">Delete</button>
            </td>
          </tr>
        `;
      });
    });
    
    tableHtml += `
        </tbody>
      </table>
    `;
    
    container.innerHTML = tableHtml;
    
    // Add event listeners for action buttons
    container.querySelectorAll('.fill-btn').forEach(btn => {
      btn.addEventListener('click', () => fillForm(parseInt(btn.dataset.entry), parseInt(btn.dataset.form)));
    });
    
    container.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', () => editForm(parseInt(btn.dataset.entry), parseInt(btn.dataset.form)));
    });
    
    container.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteForm(parseInt(btn.dataset.entry), parseInt(btn.dataset.form)));
    });
    
  } catch (error) {
    console.error('Error loading saved forms:', error);
    showStatus('Error loading saved forms: ' + error.message, 'error');
  }
}

async function fillForm(entryIndex, formIndex) {
  try {
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    if (!savedForms[entryIndex] || !savedForms[entryIndex].forms[formIndex]) {
      showStatus('Form data not found', 'error');
      return;
    }
    
    const formData = savedForms[entryIndex].forms[formIndex];
    
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.id) {
      showStatus('No active tab found', 'error');
      return;
    }
    
    // Inject and execute the fill script
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillFormOnPage,
      args: [formData]
    });
    
    if (results && results[0] && results[0].result) {
      showStatus(`Filled ${results[0].result} field(s)`, 'success');
    } else {
      showStatus('Could not fill form fields', 'error');
    }
  } catch (error) {
    console.error('Error filling form:', error);
    showStatus('Error filling form: ' + error.message, 'error');
  }
}

function fillFormOnPage(formData) {
  let filledCount = 0;
  
  formData.fields.forEach(fieldData => {
    let element = null;
    
    // Try to find element by ID first
    if (fieldData.id) {
      element = document.getElementById(fieldData.id);
    }
    
    // Try by name
    if (!element && fieldData.name) {
      element = document.querySelector(`[name="${fieldData.name}"]`);
    }
    
    // Try by XPath
    if (!element && fieldData.xpath) {
      try {
        const xpathResult = document.evaluate(
          fieldData.xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        element = xpathResult.singleNodeValue;
      } catch (e) {
        console.error('XPath error:', e);
      }
    }
    
    // Try by CSS selector
    if (!element && fieldData.selector) {
      try {
        element = document.querySelector(fieldData.selector);
      } catch (e) {
        console.error('Selector error:', e);
      }
    }
    
    if (element) {
      // Fill the element based on type
      if (fieldData.type === 'checkbox' || fieldData.type === 'radio') {
        element.checked = fieldData.checked;
      } else if (element.tagName.toLowerCase() === 'select') {
        element.value = fieldData.value;
      } else {
        element.value = fieldData.value;
      }
      
      // Trigger change event
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      
      filledCount++;
    }
  });
  
  return filledCount;
}

async function editForm(entryIndex, formIndex) {
  showStatus('Edit functionality coming soon!', 'info');
}

async function deleteForm(entryIndex, formIndex) {
  if (!confirm('Are you sure you want to delete this form?')) {
    return;
  }
  
  try {
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    if (savedForms[entryIndex] && savedForms[entryIndex].forms[formIndex]) {
      savedForms[entryIndex].forms.splice(formIndex, 1);
      
      // If no forms left in this entry, remove the entire entry
      if (savedForms[entryIndex].forms.length === 0) {
        savedForms.splice(entryIndex, 1);
      }
      
      await chrome.storage.local.set({ savedForms: savedForms });
      showStatus('Form deleted successfully!', 'success');
      viewSavedForms();
    }
  } catch (error) {
    console.error('Error deleting form:', error);
    showStatus('Error deleting form: ' + error.message, 'error');
  }
}
