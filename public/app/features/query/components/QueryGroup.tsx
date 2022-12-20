import { css } from '@emotion/css';
import React, { PureComponent } from 'react';
import DropZone, { FileRejection } from 'react-dropzone';
import { Unsubscribable } from 'rxjs';

import {
  CoreApp,
  DataFrameJSON,
  dataFrameToJSON,
  DataQuery,
  DataSourceApi,
  DataSourceInstanceSettings,
  getDefaultTimeRange,
  GrafanaTheme2,
  LoadingState,
  PanelData,
  readSpreadsheet,
} from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors';
import { DataSourcePicker, getDataSourceSrv } from '@grafana/runtime';
import { Button, CustomScrollbar, HorizontalGroup, InlineFormLabel, Modal, Themeable2, withTheme2 } from '@grafana/ui';
import { PluginHelp } from 'app/core/components/PluginHelp/PluginHelp';
import config from 'app/core/config';
import { backendSrv } from 'app/core/services/backend_srv';
import { addQuery, queryIsEmpty } from 'app/core/utils/query';
import { dataSource as expressionDatasource } from 'app/features/expressions/ExpressionDatasource';
import { DashboardQueryEditor, isSharedDashboardQuery } from 'app/plugins/datasource/dashboard';
import { GrafanaQuery, GrafanaQueryType } from 'app/plugins/datasource/grafana/types';
import { QueryGroupDataSource, QueryGroupOptions } from 'app/types';

import { isQueryWithMixedDatasource } from '../../query-library/api/SavedQueriesApi';
import { getSavedQuerySrv } from '../../query-library/api/SavedQueriesSrv';
import { PanelQueryRunner } from '../state/PanelQueryRunner';
import { updateQueries } from '../state/updateQueries';

import { GroupActionComponents } from './QueryActionComponent';
import { QueryEditorRows } from './QueryEditorRows';
import { QueryGroupOptionsEditor } from './QueryGroupOptions';
import { SavedQueryPicker } from './SavedQueryPicker';

interface Props extends Themeable2 {
  queryRunner: PanelQueryRunner;
  options: QueryGroupOptions;
  onOpenQueryInspector?: () => void;
  onRunQueries: () => void;
  onOptionsChange: (options: QueryGroupOptions) => void;
}

interface State {
  dataSource?: DataSourceApi;
  dsSettings?: DataSourceInstanceSettings;
  queries: DataQuery[];
  helpContent: React.ReactNode;
  isLoadingHelp: boolean;
  isPickerOpen: boolean;
  isAddingMixed: boolean;
  data: PanelData;
  isHelpOpen: boolean;
  defaultDataSource?: DataSourceApi;
  scrollElement?: HTMLDivElement;
  savedQueryUid?: string | null;
  initialState: {
    queries: DataQuery[];
    dataSource?: QueryGroupDataSource;
    savedQueryUid?: string | null;
  };
}

class UnThemedQueryGroup extends PureComponent<Props, State> {
  backendSrv = backendSrv;
  dataSourceSrv = getDataSourceSrv();
  querySubscription: Unsubscribable | null = null;

  state: State = {
    isLoadingHelp: false,
    helpContent: null,
    isPickerOpen: false,
    isAddingMixed: false,
    isHelpOpen: false,
    queries: [],
    savedQueryUid: null,
    initialState: {
      queries: [],
      savedQueryUid: null,
    },
    data: {
      state: LoadingState.NotStarted,
      series: [],
      timeRange: getDefaultTimeRange(),
    },
  };

  async componentDidMount() {
    const { options, queryRunner } = this.props;

    this.querySubscription = queryRunner.getData({ withTransforms: false, withFieldConfig: false }).subscribe({
      next: (data: PanelData) => this.onPanelDataUpdate(data),
    });

    try {
      const ds = await this.dataSourceSrv.get(options.dataSource);
      const dsSettings = this.dataSourceSrv.getInstanceSettings(options.dataSource);
      const defaultDataSource = await this.dataSourceSrv.get();
      const datasource = ds.getRef();
      const queries = options.queries.map((q) => ({
        ...(queryIsEmpty(q) && ds?.getDefaultQuery?.(CoreApp.PanelEditor)),
        datasource,
        ...q,
      }));
      this.setState({
        queries,
        dataSource: ds,
        dsSettings,
        defaultDataSource,
        savedQueryUid: options.savedQueryUid,
        initialState: {
          queries: options.queries.map((q) => ({ ...q })),
          dataSource: { ...options.dataSource },
          savedQueryUid: options.savedQueryUid,
        },
      });
    } catch (error) {
      console.log('failed to load data source', error);
    }
  }

  componentWillUnmount() {
    if (this.querySubscription) {
      this.querySubscription.unsubscribe();
      this.querySubscription = null;
    }
  }

  onPanelDataUpdate(data: PanelData) {
    this.setState({ data });
  }

  onChangeDataSource = async (newSettings: DataSourceInstanceSettings) => {
    const { dsSettings } = this.state;
    const currentDS = dsSettings ? await getDataSourceSrv().get(dsSettings.uid) : undefined;
    const nextDS = await getDataSourceSrv().get(newSettings.uid);

    // We need to pass in newSettings.uid as well here as that can be a variable expression and we want to store that in the query model not the current ds variable value
    const queries = await updateQueries(nextDS, newSettings.uid, this.state.queries, currentDS);

    const dataSource = await this.dataSourceSrv.get(newSettings.name);
    this.onChange({
      queries,
      savedQueryUid: null,
      dataSource: {
        name: newSettings.name,
        uid: newSettings.uid,
        type: newSettings.meta.id,
        default: newSettings.isDefault,
      },
    });

    this.setState({
      queries,
      savedQueryUid: null,
      dataSource: dataSource,
      dsSettings: newSettings,
    });
  };

  onChangeSavedQuery = async (savedQueryUid: string | null) => {
    if (!savedQueryUid?.length) {
      // leave the queries, remove the link
      this.onChange({
        queries: this.state.queries,
        savedQueryUid: null,
        dataSource: {
          name: this.state.dsSettings?.name,
          uid: this.state.dsSettings?.uid,
          type: this.state.dsSettings?.meta.id,
          default: this.state.dsSettings?.isDefault,
        },
      });

      this.setState({
        queries: this.state.queries,
        savedQueryUid: null,
        dataSource: this.state.dataSource,
        dsSettings: this.state.dsSettings,
      });
      return;
    }

    const { dsSettings } = this.state;
    const currentDS = dsSettings ? await getDataSourceSrv().get(dsSettings.uid) : undefined;

    const resp = await getSavedQuerySrv().getSavedQueries([{ uid: savedQueryUid }]);
    if (!resp?.length) {
      throw new Error('TODO error handling');
    }
    const savedQuery = resp[0];
    const isMixedDatasource = isQueryWithMixedDatasource(savedQuery);

    const nextDS = isMixedDatasource
      ? await getDataSourceSrv().get('-- Mixed --')
      : await getDataSourceSrv().get(savedQuery.queries[0].datasource?.uid);

    // We need to pass in newSettings.uid as well here as that can be a variable expression and we want to store that in the query model not the current ds variable value
    const queries = await updateQueries(nextDS, nextDS.uid, savedQuery.queries, currentDS);

    const newDsSettings = await getDataSourceSrv().getInstanceSettings(nextDS.uid);
    if (!newDsSettings) {
      throw new Error('TODO error handling');
    }
    this.onChange({
      queries,
      savedQueryUid: savedQueryUid,
      dataSource: {
        name: newDsSettings.name,
        uid: newDsSettings.uid,
        type: newDsSettings.meta.id,
        default: newDsSettings.isDefault,
      },
    });

    this.setState({
      queries,
      savedQueryUid,
      dataSource: nextDS,
      dsSettings: newDsSettings,
    });
  };

  onAddQueryClick = () => {
    const { queries } = this.state;
    this.onQueriesChange(addQuery(queries, this.newQuery()));
    this.onScrollBottom();
  };

  newQuery(): Partial<DataQuery> {
    const { dsSettings, defaultDataSource } = this.state;

    const ds = !dsSettings?.meta.mixed ? dsSettings : defaultDataSource;

    return {
      ...this.state.dataSource?.getDefaultQuery?.(CoreApp.PanelEditor),
      datasource: { uid: ds?.uid, type: ds?.type },
    };
  }

  onChange(changedProps: Partial<QueryGroupOptions>) {
    this.props.onOptionsChange({
      ...this.props.options,
      ...changedProps,
    });
  }

  onAddExpressionClick = () => {
    this.onQueriesChange(addQuery(this.state.queries, expressionDatasource.newQuery()));
    this.onScrollBottom();
  };

  onScrollBottom = () => {
    setTimeout(() => {
      if (this.state.scrollElement) {
        this.state.scrollElement.scrollTo({ top: 10000 });
      }
    }, 20);
  };

  onUpdateAndRun = (options: QueryGroupOptions) => {
    this.props.onOptionsChange(options);
    this.props.onRunQueries();
  };

  renderTopSection(styles: QueriesTabStyles) {
    const { onOpenQueryInspector, options } = this.props;
    const { dataSource, data } = this.state;

    return (
      <div>
        <div className={styles.dataSourceRow}>
          <InlineFormLabel htmlFor="data-source-picker" width={'auto'}>
            Data source
          </InlineFormLabel>
          <div className={styles.dataSourceRowItem}>
            <DataSourcePicker
              onChange={this.onChangeDataSource}
              current={options.dataSource}
              metrics={true}
              mixed={true}
              dashboard={true}
              variables={true}
            />
          </div>
          {dataSource && (
            <>
              <div className={styles.dataSourceRowItem}>
                <Button
                  variant="secondary"
                  icon="question-circle"
                  title="Open data source help"
                  onClick={this.onOpenHelp}
                />
              </div>
              <div className={styles.dataSourceRowItemOptions}>
                <QueryGroupOptionsEditor
                  options={options}
                  dataSource={dataSource}
                  data={data}
                  onChange={this.onUpdateAndRun}
                />
              </div>
              {onOpenQueryInspector && (
                <div className={styles.dataSourceRowItem}>
                  <Button
                    variant="secondary"
                    onClick={onOpenQueryInspector}
                    aria-label={selectors.components.QueryTab.queryInspectorButton}
                  >
                    Query inspector
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
        {config.featureToggles.queryLibrary && (
          <>
            <div className={styles.dataSourceRow}>
              <InlineFormLabel htmlFor="saved-query-picker" width={'auto'}>
                Saved query
              </InlineFormLabel>
              <div className={styles.dataSourceRowItem}>
                <SavedQueryPicker current={this.state.savedQueryUid} onChange={this.onChangeSavedQuery} />
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  onOpenHelp = () => {
    this.setState({ isHelpOpen: true });
  };

  onCloseHelp = () => {
    this.setState({ isHelpOpen: false });
  };

  renderMixedPicker = () => {
    return (
      <DataSourcePicker
        mixed={false}
        onChange={this.onAddMixedQuery}
        current={null}
        autoFocus={true}
        variables={true}
        onBlur={this.onMixedPickerBlur}
        openMenuOnFocus={true}
      />
    );
  };

  onAddMixedQuery = (datasource: any) => {
    this.onAddQuery({ datasource: datasource.name });
    this.setState({ isAddingMixed: false });
  };

  onMixedPickerBlur = () => {
    this.setState({ isAddingMixed: false });
  };

  onAddQuery = (query: Partial<DataQuery>) => {
    const { dsSettings, queries } = this.state;
    this.onQueriesChange(addQuery(queries, query, { type: dsSettings?.type, uid: dsSettings?.uid }));
    this.onScrollBottom();
  };

  onQueriesChange = (queries: DataQuery[]) => {
    this.onChange({ queries });
    this.setState({ queries });
  };

  renderQueries(dsSettings: DataSourceInstanceSettings) {
    const { onRunQueries } = this.props;
    const { data, queries } = this.state;

    if (isSharedDashboardQuery(dsSettings.name)) {
      return (
        <DashboardQueryEditor
          queries={queries}
          panelData={data}
          onChange={this.onQueriesChange}
          onRunQueries={onRunQueries}
        />
      );
    }

    return (
      <div aria-label={selectors.components.QueryTab.content}>
        <QueryEditorRows
          queries={queries}
          dsSettings={dsSettings}
          onQueriesChange={this.onQueriesChange}
          onAddQuery={this.onAddQuery}
          onRunQueries={onRunQueries}
          data={data}
        />
      </div>
    );
  }

  isExpressionsSupported(dsSettings: DataSourceInstanceSettings): boolean {
    return (dsSettings.meta.alerting || dsSettings.meta.mixed) === true;
  }

  renderExtraActions() {
    return GroupActionComponents.getAllExtraRenderAction()
      .map((action, index) =>
        action({
          onAddQuery: this.onAddQuery,
          onChangeDataSource: this.onChangeDataSource,
          key: index,
        })
      )
      .filter(Boolean);
  }

  renderAddQueryRow(dsSettings: DataSourceInstanceSettings, styles: QueriesTabStyles) {
    const { isAddingMixed } = this.state;
    const showAddButton = !(isAddingMixed || isSharedDashboardQuery(dsSettings.name));

    return (
      <HorizontalGroup spacing="md" align="flex-start">
        {showAddButton && (
          <Button
            icon="plus"
            onClick={this.onAddQueryClick}
            variant="secondary"
            aria-label={selectors.components.QueryTab.addQuery}
          >
            Query
          </Button>
        )}
        {config.expressionsEnabled && this.isExpressionsSupported(dsSettings) && (
          <Button
            icon="plus"
            onClick={this.onAddExpressionClick}
            variant="secondary"
            className={styles.expressionButton}
          >
            <span>Expression&nbsp;</span>
          </Button>
        )}
        {this.renderExtraActions()}
      </HorizontalGroup>
    );
  }

  setScrollRef = (scrollElement: HTMLDivElement): void => {
    this.setState({ scrollElement });
  };

  onFileDrop = (files: File[], rejectedFiles: FileRejection[]) => {
    const snapshot: DataFrameJSON[] = [];

    files.forEach((file) => {
      const reader = new FileReader();
      reader.readAsArrayBuffer(file);
      // TODO Add error and progress handling
      reader.onload = () => {
        const result = reader.result;
        if (result) {
          if (typeof result === 'string') {
            return;
          }
          const dataFrames = readSpreadsheet(result);
          dataFrames.forEach((df) => {
            const dataframeJson = dataFrameToJSON(df);
            snapshot.push(dataframeJson);
          });
        }
        // TODO only update state when all the files are loaded
        this.props.onRunQueries();
      };
    });

    // RejectedFiles only going to be files that are exceeds the maxSize
    if (rejectedFiles.length) {
      this.onPanelDataUpdate({
        ...this.state.data,
        state: LoadingState.Error,
        error: {
          message: `File size exceeded for ${rejectedFiles
            .map((rf) => {
              return rf.file.name;
            })
            .join(',')}.`,
        },
      });
    }

    const grafanaDS = {
      type: 'grafana',
      uid: 'grafana',
    };
    const query = {
      queryType: GrafanaQueryType.Snapshot,
      snapshot,
      datasource: grafanaDS,
    } as GrafanaQuery;
    this.onChange({
      dataSource: grafanaDS,
      queries: [query],
    });

    this.setState({
      queries: [query],
    });
  };

  render() {
    const { isHelpOpen, dsSettings } = this.state;

    return (
      <CustomScrollbar autoHeightMin="100%" scrollRefCallback={this.setScrollRef}>
        <DropZone onDrop={this.onFileDrop} noClick maxSize={200000}>
          {({ getRootProps, isDragActive }) => {
            const styles = getStyles(this.props.theme, isDragActive);
            return (
              <div {...getRootProps({ className: styles.dropzone })}>
                {this.renderTopSection(styles)}
                {dsSettings && (
                  <>
                    <div className={styles.queriesWrapper}>{this.renderQueries(dsSettings)}</div>
                    {this.renderAddQueryRow(dsSettings, styles)}
                    {isHelpOpen && (
                      <Modal title="Data source help" isOpen={true} onDismiss={this.onCloseHelp}>
                        <PluginHelp plugin={dsSettings.meta} type="query_help" />
                      </Modal>
                    )}
                  </>
                )}
              </div>
            );
          }}
        </DropZone>
      </CustomScrollbar>
    );
  }
}

export const QueryGroup = withTheme2(UnThemedQueryGroup);

function getStyles(theme: GrafanaTheme2, isDragActive?: boolean) {
  return {
    dropzone: css`
      display: flex;
      flex-direction: column;
      padding: ${theme.spacing(2)};
      border: ${isDragActive ? `2px dashed ${theme.colors.border.medium}` : 0};
      background-color: ${isDragActive ? theme.colors.action.hover : theme.colors.background.primary};
    `,
    dataSourceRow: css`
      display: flex;
      margin-bottom: ${theme.spacing(2)};
    `,
    dataSourceRowItem: css`
      margin-right: ${theme.spacing(0.5)};
    `,
    dataSourceRowItemOptions: css`
      flex-grow: 1;
      margin-right: ${theme.spacing(0.5)};
    `,
    queriesWrapper: css`
      padding-bottom: 16px;
    `,
    expressionWrapper: css``,
    expressionButton: css`
      margin-right: ${theme.spacing(1)};
    `,
  };
}

type QueriesTabStyles = ReturnType<typeof getStyles>;
